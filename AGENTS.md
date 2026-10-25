# AGENTS.md: AP4M Hackathon project

Instructions for AI coding agents working in this project. This project builds on the AP4M payment kit for the
Mastercard XRPL Hackathon: an Agent that pays within a funded budget, and optionally an x402 Merchant.

## Read first

- Set `AP4M_API_URL` to the service URL. Fetch `https://hackathon.ap4m.build/llms.txt` for the guide index, network and contract
  addresses, or `https://hackathon.ap4m.build/llms-full.txt` for every guide in one file.
- Main guides: `/docs/quickstart.md`, `/docs/x402.md`, `/docs/api-reference.md`, `/docs/receipts.md`,
  `/docs/troubleshooting.md`, and the SDK reference `/sdk/README.md`.
- Treat those documents as the source of truth for endpoints and function signatures; do not guess them.

## Facts to rely on

- Network: XRPL EVM Testnet, chain ID 1449000, RPC `https://rpc.testnet.xrplevm.org`. Gas is paid in XRP, from
  the [XRPL EVM Testnet faucet](https://faucet.testevm.ripple.com). If `https://hackathon.ap4m.build/llms.txt` lists different values, use those.
- RLUSD has 18 decimals. Convert with `ethers.parseUnits(value, 18)` and `ethers.formatUnits(value, 18)`; never
  write the zeros by hand.
- Voucher amounts are cumulative per Channel (the running total), not per payment.
- Use ethers v6. Install the AP4M SDK from the service, not from the public npm registry:
  `npm install ethers@6.17.0 https://hackathon.ap4m.build/sdk/ap4m-sdk.tgz`. Node.js 22.13 or later.
- Helper files from `https://hackathon.ap4m.build/sdk/`: `ap4m-hackathon-sdk.js` (CommonJS: `signIn`, `requestChannel`,
  `listChannels`, `listMerchants`, `signVoucher`, `redeemVoucher`, `getChannelState`, `settle`, `closeChannel`),
  `ap4m-x402.mjs` (ES module: `loadX402Context`, `buyResource`, `createX402Merchant`) and `verify-receipt.mjs`.
  In a project with `"type": "module"`, download the CommonJS helpers as `ap4m-hackathon-sdk.cjs` and
  `import sdk from './ap4m-hackathon-sdk.cjs'`.
- `signIn` needs only the key. Connect the Agent wallet to the RPC from `/llms.txt` for `requestChannel` and
  `signVoucher`; `signVoucher` refuses a wallet without a provider (`redeemVoucher` connects it for you).
- Channel limits per budget deposit are listed in `/llms.txt`; reuse an open Channel for many payments. Any price
  above zero settles.
- `buyResource` handles one purchase at a time per state directory: resume an unresolved purchase with its original
  arguments before starting another, and keep the Merchant running when you repeat an operation.
- Team onboarding (adding the Agent and Merchant wallets, funding the budget) happens in the participant portal at
  `https://hackathon.ap4m.build/participant`, not in code. Code starts after the Agent is onboarded and the budget is funded.
- The flow in code: `signIn` with the Agent wallet, `requestChannel` to a Merchant, pay with `buyResource` (x402)
  or `redeemVoucher`, then optionally `settle` (returns `receipt_url`) and `closeChannel`. Settlement, payouts,
  the post-event close and receipts are automatic.
- Give each `buyResource` purchase a new `operation` name; reusing one returns the earlier purchase.
- A Channel pays the team's own Merchant. Another team's `merchantId` works only when the organizers turn on
  cross-team payments (`/llms.txt` reports it); otherwise it is refused with HTTP 403.
- A Merchant called from other machines must be served over HTTPS.

## Safety rules

- Never commit, print, log or send private keys. Read them from environment variables (`AGENT_PRIVATE_KEY`,
  `MERCHANT_SUBMITTER_KEY`) or an untracked `.env` file, and keep `.env` in `.gitignore`.
- Never send a private key to the AP4M service or any other API; the service only ever needs signatures.
- The team holds only its funding, Agent and Merchant wallets. Operator, PSP, payout, release and admin keys belong
  to the service; never ask for, generate or configure them in this project (see `/docs/keys.md`).
- Do not send RLUSD or XRP to the vault or ledger contract addresses directly.
- This kit is for the hackathon testnet only; do not point it at a mainnet.
