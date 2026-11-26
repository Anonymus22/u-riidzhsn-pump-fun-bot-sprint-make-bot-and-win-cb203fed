# Pump.fun Bot Sprint

[![Competition](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Anonymus22/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Anonymus22/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A deterministic momentum paper-trading bot for the [Pump.fun Bot Sprint](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) competition on make.fun. It trades paper SOL on a replay of pump.fun bonding-curve data, ranked by net PnL. No real money is ever involved.

## Strategy

- **Entry — confirmed momentum only.** A coin becomes a buy when, over the last 60 slots, it has at least 4 buy trades from at least 3 distinct wallets, net inflow of at least 0.5 SOL, a price up 8–150% from the window start, and the price holding within 10% of the window high. Coins younger than 120 slots are skipped, and only curves with 1–80 SOL of real reserves qualify.
- **Sizing.** One fixed stake of 0.1 SOL per coin, capped at 100 bps of the curve's real SOL reserve. At most 5 open positions; no shorts, no leverage.
- **Exits.** Take profit at +30%, hard stop-loss at −18%, a trailing stop (arms at +10%, sells on a 20% pullback from the peak), a fade exit when net flow over 20 slots turns below −0.5 SOL, and a hard max hold of 1,500 slots.
- **Rotation.** Capital rotates across many coins so the 20-coin round-trip guardrail is met comfortably. A tiny 0.02 SOL probe trade keeps the coin pace up when momentum entries run dry, exiting at +5% / −12% or after 400 slots.
- **Deterministic.** No clock, no randomness, no environment reads — the only inputs are the `hello` seed and the batch stream, so two runs produce byte-identical action logs.

## Layout

- `main.ts` — the bot entrypoint (Node 22, stdlib only, no network).
- `vendor/makefun-bot.ts` — the vendored `agent-fun/replay/v2` shim (byte-identical copy of the kit SDK).
- `.makefun/owner.json` — entry ownership claim.

## Run

The grader runs it as `node /bot/main.ts`. It reads `hello` + `batch` messages on stdin and writes one JSON reply line per batch on stdout.
