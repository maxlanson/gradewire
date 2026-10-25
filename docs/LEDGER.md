# Ledger as the trust layer

A Ledger device is the human approval step for the one action in Gradewire that can move a node's locked money: releasing a bond. Everything the agent does on its own is bounded by capped AP4M Channels, so no software key anywhere in the system holds unlimited spending power.

## What is gated, and why it is the high-risk action

A node's **bond** (RLUSD locked in `GradewireRegistry`) is the collateral behind every grade it sells. It is what gets slashed to refund the buyer and pay the verifiers when a re-run proves the node cheated. If a node could withdraw its bond with its own key alone, a stolen node key would drain the bond before a slash lands, and a cheating node could pull its collateral the moment it saw a verification task open.

`GradewireRegistry.withdrawBond(amount, deadline, approval)` (`contracts/src/GradewireRegistry.sol`) therefore refuses unless:

- `approval` is an EIP-712 signature over `WithdrawApproval(address provider, uint256 amount, uint256 nonce, uint256 deadline)` that recovers to the **approver** address fixed at deploy;
- the node has no open verification task (`openTasks == 0`), so a bond under review cannot leave;
- the nonce matches `withdrawNonce[provider]` (each approval is single-use) and `block.timestamp <= deadline`;
- the node is not suspended.

The approver is meant to be a hardware wallet: a human reads the provider, the amount and the deadline on the device screen and approves. The node key submits the transaction, but it cannot produce the approval.

## The agent never holds a raw unlimited key

The paying agent (`scripts/ask.sh`, `scripts/trainer.sh`) spends only through AP4M **Channels**, each opened with a cap (`CHANNEL_CAP`, default 0.5 RLUSD). A Voucher cannot exceed its Channel's cap, so a compromised agent key can lose at most the open caps, not the budget. The approver key is never on the laptop at all when a Ledger is used: `--ledger` sends the typed data to the device and gets back only a signature.

## The on-device flow

Two steps, two scripts. Step 1 produces the approval; step 2 is run by the node and submits the withdrawal.

```bash
# 0. (once) which address does the device hold at the default path, and is it the registry approver?
node --env-file=.env scripts/ledger-address.mjs [--path "44'/60'/0'/0/0"] [--display]

# 1. approve: plug in the Ledger, unlock it, open the Ethereum app, then
node --env-file=.env scripts/approve-withdraw.mjs --provider 0x<node address> --amount 0.01 --ledger [--path "44'/60'/0'/0/0"]

# 2. withdraw: the node submits with the printed signature (prints the RLUSD balance before/after)
node --env-file=.env scripts/withdraw-bond.mjs --port 4401 --amount 0.01 --deadline <unix> --signature 0x...
```

What `--ledger` does, in order (`scripts/approve-withdraw.mjs`):

1. Reads the approver and the node's `withdrawNonce` from the registry, builds the EIP-712 payload and prints it (same as every mode).
2. Opens the first Ledger over USB HID (`@ledgerhq/hw-transport-node-hid`: `list()` then `open(path)`; it fails fast with "no Ledger device found" rather than waiting).
3. `getAddress(path)` (`@ledgerhq/hw-app-eth`) and prints the device address. If it is not the on-chain approver it warns loudly and continues, because the signature will still be useful once the registry's approver is switched (below). With the current testnet deployment this warning is **expected**: the approver is the software dev key.
4. `signEIP712Message(path, typedData)`: the device shows the domain and every `WithdrawApproval` field (provider, amount, nonce, deadline) for review. Approve on the device.
5. If the Ethereum app refuses the full EIP-712 message (older firmware, or an unknown chain without blind signing), the script falls back to `signEIP712HashedMessage(path, domainSeparator, hashStruct)` with both hashes computed by ethers' `TypedDataEncoder`. The device then shows only the two 32-byte hashes, which the Ethereum app allows only with **blind signing enabled** (Ethereum app > Settings > Blind signing > Enabled). The script prints both hashes so the human can compare them with the device screen.
6. Normalises `v` (the device returns 27/28, some firmware 0/1), assembles the 65-byte `r || s || v` signature, recovers it locally with `ethers.verifyTypedData` and refuses to print a signature that does not recover to the device address.
7. Prints the `next:` command for `scripts/withdraw-bond.mjs`, exactly as `--dev` does, so step 2 is unchanged.

`--dev` is the fallback without a device: it signs the identical payload with `APPROVER_DEV_PRIVATE_KEY`, the software approver the current testnet registry was deployed with. With neither flag the script only prints the payload for any other `eth_signTypedData_v4` signer (Ledger Live, Rabby, Frame).

The Ledger packages are loaded lazily through `createRequire` inside `--ledger` only (their ESM builds use extensionless imports Node rejects; the CommonJS builds work). Without them, or without a device, `--dev` and the print-only mode keep working.

## Chain ID

The EIP-712 domain uses the chain ID the registry was deployed on, read live from the RPC and cross-checked against `deployments/testnet.json` (**1449000**, XRPL EVM Testnet, the value AP4M uses). The registry computes its domain separator from `block.chainid` at construction, so the signature only verifies for that chain.

Ledger's own XRPL EVM page lists **1440000**, which is the XRPL EVM **mainnet** chain ID. The Ethereum app signs EIP-712 for any chain ID; the number only matters for what the device displays and for whether it treats the network as known (an unknown network may push it to the hashed fallback above). **Confirm at the Ledger booth** which chain ID their signer expects for XRPL EVM Testnet and whether full EIP-712 display works there; if not, enable blind signing and use the fallback path. Do not change the domain chain ID to 1440000: the contract would reject the signature.

## Making the device the approver

Today's testnet registry (`deployments/testnet.json`, `approver`) was deployed with the software dev key as approver, since no device was available. Two ways to switch to the Ledger address printed by `scripts/ledger-address.mjs`:

**Without redeploying** (one owner transaction; the coordinator key is the registry owner):

```bash
cast send 0x8362da758e5bf63bc21f2e7bb0ec49c89879b7c3 "setApprover(address)" 0x<ledger address> \
  --rpc-url https://rpc.testnet.xrplevm.org --private-key "$COORDINATOR_PRIVATE_KEY"
```

then update `approver` in `deployments/testnet.json`.

**Redeploying** (`contracts/script/Deploy.s.sol` reads the approver from the environment variable `APPROVER_ADDRESS`; it also needs `COORDINATOR_PRIVATE_KEY`, `RLUSD_TOKEN`, `TREASURY_ADDRESS`, `OPERATOR1_ADDRESS`, `OPERATOR2_ADDRESS`, `OPERATOR3_ADDRESS` and optionally `MIN_BOND_WEI`):

```bash
export APPROVER_ADDRESS=0x<ledger address>
(cd contracts && forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.xrplevm.org --broadcast)
# copy REGISTRY and SERVICE_MANAGER from the output into deployments/testnet.json (registry, serviceManager,
# approver, deployBlock), re-export the ABIs if they changed, then re-fund and re-bond the nodes
```

A redeploy resets every node's registration and bond, so prefer `setApprover` during the hackathon.

## What was and was not exercised

Exercised on this machine, without a device:

- `npm install @ledgerhq/hw-transport-node-hid@6.33.5 @ledgerhq/hw-app-eth@7.11.1` succeeds on macOS arm64; `node-hid` 2.1.2 loads its bundled prebuilt binary (no local native build was needed, and no install scripts ran).
- `--dev` end to end for node 4401 at 0.01 RLUSD: the printed signature recovers to the on-chain approver locally (no transaction sent).
- `--ledger` without a device: the packages load and the script exits with "no Ledger device found" after printing the payload.
- The hashed fallback's math: `keccak256(0x1901 || hashDomain || hashStruct)` equals `TypedDataEncoder.hash` for this payload, and a signature assembled from `r, s, v` with `v` given as either 28 or 1 recovers to the signer.

**Not exercised** (no Ledger device was available at the table):

- `getAddress`, `signEIP712Message` and `signEIP712HashedMessage` against a real device, including what the Ethereum app displays for chain 1449000 and whether it needs blind signing.
- Submitting a Ledger-signed approval on-chain. The contract check itself was exercised with the software approver (wrong signer and replay refused; see `docs/SUBMISSION.md`).
- `setApprover` / redeploy with the device address.

The code paths for the device follow the documented `@ledgerhq/hw-app-eth` 7.11.1 API (`Eth.d.ts` in `node_modules`) and the transport's `list` / `open` static methods; if the booth has a device, run `scripts/ledger-address.mjs` first, then `--ledger` on a 0.01 RLUSD withdrawal.
