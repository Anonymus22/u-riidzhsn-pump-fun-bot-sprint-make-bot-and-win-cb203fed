// Pump.fun Bot Sprint — momentum paper-trading bot (agent-fun/replay/v2).
//
// Strategy in one paragraph: watch every new pump.fun bonding curve, wait until it
// shows real momentum (several distinct buyers, net SOL flowing in, price rising and
// holding near its recent high), then buy a small fixed stake. Ride winners with a
// take-profit and a trailing stop, cut losers with a hard stop-loss, and never hold a
// coin long. Capital rotates across many coins so the 20-coin round-trip guardrail is
// met with room to spare; a tiny probe trade keeps the pace up when momentum entries
// run dry. Paper trading only: no real money ever moves.
//
// Wire notes: the harness sends a hello message first, then one batch per slot, then
// done. The bot answers each batch with exactly one reply line carrying the orders
// decided on that slot; orders fill two slots later (the slot latency in hello).
// Everything is deterministic: no clock, no randomness, no environment reads — the
// only inputs are the hello seed and the batch stream, so two runs produce identical
// action logs.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- constants

const LAMPORTS = 1_000_000_000n; // 1 SOL, as bigint lamports
const BPS = 10_000n;

// Entry: momentum window and filters.
const WINDOW_SLOTS = 60; // lookback window for the entry signal, in slots
const MIN_AGE_SLOTS = 120; // slots since CreateEvent before a coin may be bought
const MIN_NET_LAMPORTS = 500_000_000n; // >= 0.5 SOL net inflow over the window
const MIN_BUYS = 4; // buy trades inside the window
const MIN_BUYERS = 3; // distinct buying wallets inside the window
const MIN_UP_BPS = 800; // price must be up >= 8% over the window
const MAX_UP_BPS = 15_000; // ... but not more than 150% (already ran too far)
const NEAR_HIGH_BPS = 9_000; // price must sit within 10% of the window high
const MIN_REAL_SOL = 1_000_000_000n; // curve real SOL at entry: >= 1 SOL
const MAX_REAL_SOL = 80_000_000_000n; // ... and <= 80 SOL (not already huge)

// Sizing.
const STAKE_LAMPORTS = 100_000_000n; // 0.1 SOL per entry
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: the round-trip guardrail floor
const BUY_SLIPPAGE_BPS = 2_000;
const SELL_SLIPPAGE_BPS = 10_000;

// Exits (all measured against the position's cost, fees included).
const TAKE_PROFIT_BPS = 3_000; // sell when value >= cost * 1.30
const STOP_LOSS_BPS = 1_800; // sell when value <= cost * 0.82
const TRAIL_ARM_BPS = 1_000; // trailing stop arms once value >= cost * 1.10
const TRAIL_BPS = 2_000; // ... then sell when value falls 20% below its peak
const MAX_HOLD_SLOTS = 1_500; // hard time exit (~10 minutes of slots)
const FADE_WINDOW_SLOTS = 20; // exit when net flow over this window turns negative
const FADE_NET_LAMPORTS = -500_000_000n; // ... by at least 0.5 SOL of net selling

// Re-entry rules per coin.
const COOLDOWN_SLOTS = 300; // slots to wait after an exit before buying again
const MAX_ENTRIES_PER_MINT = 2;

// Probe trades: keep the 20-coin round-trip guardrail on pace when momentum
// entries are scarce. One probe at a time, tiny stake, quick exit.
const PROBE_LAMPORTS = 20_000_000n; // 0.02 SOL
const PROBE_TAKE_BPS = 500; // sell probe at +5%
const PROBE_STOP_BPS = 1_200; // ... or -12%
const PROBE_MAX_HOLD_SLOTS = 400;
const PROBE_PACE_SLOTS = 1_200; // expect roughly one new coin per this many slots

// Curve fee taken on sells (protocol 95 bps + creator 30 bps = 125 bps).
const CURVE_FEE_BPS = 125n;

// ---------------------------------------------------------------- per-coin tape

interface TapeTrade {
  slot: number;
  buy: boolean;
  solLamports: bigint;
  user: string;
  priceNum: bigint; // virtual_quote_reserves at the trade
  priceDen: bigint; // virtual_token_reserves at the trade
}

interface Tape {
  createdSlot: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExitSlot: number;
}

interface Held {
  openedSlot: number;
  peakValueLamports: bigint;
  exiting: boolean;
  filled: boolean;
  probe: boolean;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
const boughtCoins = new Set<Pubkey>(); // mints where a buy of >= 0.01 SOL filled
const roundTripped = new Set<Pubkey>(); // mints where a buy and a later sell filled
const probeMints = new Set<Pubkey>();
let firstSlot = -1;
let myFills = 0;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { createdSlot: null, trades: [], entries: 0, lastExitSlot: -1 };
    tapes.set(mint, t);
  }
  return t;
}

/** Price of a trade as a float ratio (quote per token), for momentum math only. */
function tradePrice(tr: TapeTrade): number {
  if (tr.priceDen === 0n) return 0;
  return Number(tr.priceNum) / Number(tr.priceDen);
}

/**
 * Momentum entry signal for one curve at slot `now`.
 * True when the window shows accelerating buy pressure: enough distinct buyers,
 * net SOL in, price up but not parabolic, and price holding near the window high.
 */
function entrySignal(t: Tape, now: number, realSolLamports: bigint): boolean {
  if (realSolLamports < MIN_REAL_SOL || realSolLamports > MAX_REAL_SOL) return false;
  if (t.createdSlot === null || now - t.createdSlot < MIN_AGE_SLOTS) return false;
  const from = now - WINDOW_SLOTS;
  let buyLamports = 0n;
  let sellLamports = 0n;
  let buys = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const buyers = new Set<string>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tradePrice(tr);
      continue;
    }
    if (startPrice < 0) startPrice = tradePrice(tr);
    if (tr.buy) {
      buyLamports += tr.solLamports;
      buys++;
      buyers.add(tr.user);
    } else {
      sellLamports += tr.solLamports;
    }
    const p = tradePrice(tr);
    if (p > high) high = p;
    last = p;
  }
  if (buys < MIN_BUYS || buyers.size < MIN_BUYERS) return false;
  if (buyLamports - sellLamports < MIN_NET_LAMPORTS) return false;
  if (startPrice <= 0 || last <= 0 || high <= 0) return false;
  const upBps = Math.floor(((last / startPrice) - 1) * 10_000);
  if (upBps < MIN_UP_BPS || upBps > MAX_UP_BPS) return false;
  if (last < high * (NEAR_HIGH_BPS / 10_000)) return false;
  return true;
}

/** Net SOL flow (buys minus sells) over the last `windowSlots` slots. */
function netFlow(t: Tape, now: number, windowSlots: number): bigint {
  let net = 0n;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - windowSlots) break;
    net += tr.buy ? tr.solLamports : -tr.solLamports;
  }
  return net;
}

/**
 * Mark-to-market value of `tokenAmount` tokens on `curve`, in lamports, after the
 * bonding-curve fee and one transaction fee. Uses the constant-product payout:
 * quote out = tokens * virtualQuote / (virtualToken + tokens).
 */
function positionValueLamports(
  tokenAmount: bigint,
  virtualQuote: bigint,
  virtualToken: bigint,
  txFeeLamports: bigint,
): bigint {
  if (tokenAmount === 0n || virtualToken === 0n) return 0n;
  const gross = (tokenAmount * virtualQuote) / (virtualToken + tokenAmount);
  const afterFee = (gross * (BPS - CURVE_FEE_BPS)) / BPS;
  const net = afterFee - txFeeLamports;
  return net > 0n ? net : 0n;
}

// ---------------------------------------------------------------- the bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    if (firstSlot < 0) firstSlot = now;
    const { caps } = state.hello;
    const txFee = state.txFeeLamports();
    const maxOrders = caps.max_orders_per_batch;

    // Fold this batch's fills into the round-trip bookkeeping.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      myFills++;
      if (f.side === 'buy' && BigInt(f.quote_lamports) >= MIN_BUY_LAMPORTS) {
        boughtCoins.add(f.mint);
      }
      if (f.side === 'sell' && boughtCoins.has(f.mint)) {
        roundTripped.add(f.mint);
      }
    }

    // Fold this batch's events into the per-coin tapes.
    const traded = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          solLamports: BigInt(e.sol_amount),
          user: e.user,
          priceNum: BigInt(e.virtual_quote_reserves),
          priceDen: BigInt(e.virtual_token_reserves),
        });
        traded.add(e.mint);
      }
    }
    // Prune old tape entries so memory stays bounded over a 6-hour replay.
    const keepFrom = now - Math.max(WINDOW_SLOTS, FADE_WINDOW_SLOTS) - 5;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= keepFrom) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
    for (const po of state.pending.values()) {
      const entry = pendingByMint.get(po.order.mint) ?? { buy: false, sell: false };
      if (po.order.side === 'buy') entry.buy = true;
      else entry.sell = true;
      pendingByMint.set(po.order.mint, entry);
    }

    const orders: OrderInput[] = [];
    const push = (o: OrderInput): boolean => {
      if (orders.length >= maxOrders) return false;
      orders.push(o);
      return true;
    };

    // ---- exits first: take-profit, stop-loss, trailing stop, fade, max hold.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      const pending = pendingByMint.get(mint);
      if (pos === undefined) {
        // Position gone (sold, or the harness closed it): drop the record unless
        // an order for it is still in flight. A probe exit does not count as a
        // momentum exit: it must not start the re-entry cooldown, or a probe
        // would block the real momentum entry on the same coin.
        if (pending === undefined) {
          held.delete(mint);
          probeMints.delete(mint);
          if (h.filled && !h.probe) tapeOf(mint).lastExitSlot = now;
          else if (!h.filled) tapeOf(mint).entries -= 1; // the buy never landed; refund the entry
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue; // harness closes it
      const value = positionValueLamports(
        pos.token_amount,
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
        txFee,
      );
      const cost = pos.cost_lamports;
      if (value > h.peakValueLamports) h.peakValueLamports = value;
      let exit = h.exiting;
      if (!exit) {
        if (h.probe) {
          if (value >= (cost * (BPS + BigInt(PROBE_TAKE_BPS))) / BPS) exit = true;
          else if (value <= (cost * (BPS - BigInt(PROBE_STOP_BPS))) / BPS) exit = true;
          else if (now - h.openedSlot > PROBE_MAX_HOLD_SLOTS) exit = true;
        } else {
          if (value >= (cost * (BPS + BigInt(TAKE_PROFIT_BPS))) / BPS) exit = true;
          else if (value <= (cost * (BPS - BigInt(STOP_LOSS_BPS))) / BPS) exit = true;
          else if (
            h.peakValueLamports >= (cost * (BPS + BigInt(TRAIL_ARM_BPS))) / BPS &&
            value <= (h.peakValueLamports * (BPS - BigInt(TRAIL_BPS))) / BPS
          ) {
            exit = true;
          } else if (netFlow(tapeOf(mint), now, FADE_WINDOW_SLOTS) < FADE_NET_LAMPORTS) {
            exit = true;
          } else if (now - h.openedSlot > MAX_HOLD_SLOTS) {
            exit = true;
          }
        }
      }
      if (!exit) continue;
      h.exiting = true;
      if (pending?.sell) continue; // a sell is already in flight; wait for it
      if (!push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS })) break;
    }

    // ---- entries: momentum buys on coins traded in this batch.
    let free = state.freeCashLamports();
    let slotsLeft = caps.max_open_positions - state.committedPositionCount();
    for (const mint of traded) {
      if (orders.length >= maxOrders || slotsLeft <= 0) break;
      if (held.has(mint) || probeMints.has(mint)) continue;
      if (pendingByMint.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const t = tapeOf(mint);
      if (t.entries >= MAX_ENTRIES_PER_MINT) continue;
      if (now - t.lastExitSlot < COOLDOWN_SLOTS) continue;
      if (!entrySignal(t, now, curve.real_quote_reserves)) continue;
      // The buys on one coin in one reply share one size cap: 100 bps of real reserve.
      const capLamports = state.maxBuyLamports(mint);
      let amount = STAKE_LAMPORTS < capLamports ? STAKE_LAMPORTS : capLamports;
      if (amount > free - txFee) amount = free - txFee;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (!push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS })) break;
      free -= amount + txFee;
      slotsLeft -= 1;
      held.set(mint, { openedSlot: now, peakValueLamports: 0n, exiting: false, filled: false, probe: false });
      t.entries += 1;
    }

    // ---- guardrail probes: one tiny round trip at a time when the coin pace lags.
    // Pace target: about one new coin per PROBE_PACE_SLOTS slots since the first batch.
    // Probes wait until the replay is well under way (so early momentum gets the
    // first chance at fresh coins) and only touch liquid curves.
    const PROBE_MIN_ELAPSED_SLOTS = 3_000;
    const PROBE_MIN_REAL_LAMPORTS = 3_000_000_000n; // >= 3 SOL of real reserves
    const expectedCoins = Math.min(25, Math.floor((now - firstSlot) / PROBE_PACE_SLOTS) + 1);
    if (
      probeMints.size === 0 &&
      roundTripped.size < 20 &&
      boughtCoins.size < expectedCoins &&
      now - firstSlot > PROBE_MIN_ELAPSED_SLOTS &&
      slotsLeft > 0 &&
      orders.length < maxOrders
    ) {
      for (const mint of traded) {
        if (orders.length >= maxOrders) break;
        if (held.has(mint) || probeMints.has(mint) || pendingByMint.has(mint)) continue;
        if (state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves < PROBE_MIN_REAL_LAMPORTS) continue;
        // Only probe a liquid curve: the 1%-of-real-reserve cap must cover the probe.
        if (state.maxBuyLamports(mint) < PROBE_LAMPORTS) continue;
        if (free < PROBE_LAMPORTS + 2n * txFee) break;
        if (!push({ side: 'buy', mint, quote_lamports: PROBE_LAMPORTS, max_slippage_bps: BUY_SLIPPAGE_BPS })) break;
        free -= PROBE_LAMPORTS + txFee;
        probeMints.add(mint);
        held.set(mint, { openedSlot: now, peakValueLamports: 0n, exiting: false, filled: false, probe: true });
        break; // one probe at a time
      }
    }

    return orders;
  },
});
