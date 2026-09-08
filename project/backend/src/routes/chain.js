const { randomUUID } = require("crypto");
const { Router } = require("express");
const { z } = require("zod");
const { Interface, parseEther } = require("ethers");
const {
  acquireLicenseOnChain,
  buildAcquireTxRequest,
  buildListTxRequest,
  chainConfig,
  getProvider,
  getChainStatus,
  getOnChainListing,
  listModelOnChain,
} = require("../chain/marketplace");
const { findModel, store } = require("../data/store");
const { optionalAuth } = require("../middleware/auth");

const chainRouter = Router();
const addressPattern = /^0x[a-fA-F0-9]{40}$/;

function addressesMatch(left, right) {
  return left?.toLowerCase() === right?.toLowerCase();
}

async function verifyWalletListTransaction({ txHash, walletAddress, slug, metadataURI, listing }) {
  const provider = getProvider();
  const [tx, receipt] = await Promise.all([
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
  ]);
  if (!tx || !receipt || receipt.status !== 1 || !addressesMatch(tx.to, chainConfig.marketplace)) {
    return false;
  }
  if (!addressesMatch(tx.from, walletAddress)) return false;

  try {
    const parsed = new Interface(chainConfig.abi).parseTransaction({ data: tx.data, value: tx.value });
    return (
      parsed?.name === "listModel" &&
      parsed.args[0] === slug &&
      parsed.args[1] === metadataURI &&
      parsed.args[2].toString() === listing.priceWei &&
      Number(parsed.args[3]) === listing.royaltyBps
    );
  } catch {
    return false;
  }
}

const listSchema = z.object({
  mode: z.enum(["relay", "tx", "confirm"]).default("relay"),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  walletAddress: z.string().regex(addressPattern).optional(),
  metadataURI: z.string().min(1).max(2048).optional(),
  priceEth: z.number().min(0).max(100).optional(),
  royaltyBps: z.number().int().min(0).max(10_000).optional(),
});

chainRouter.get("/status", async (_req, res) => {
  const status = await getChainStatus();
  res.json({
    ...status,
    config: {
      marketplace: chainConfig.marketplace,
      chainId: chainConfig.chainId,
      rpcUrl: chainConfig.rpcUrl,
    },
  });
});

chainRouter.get("/config", (_req, res) => {
  res.json({
    marketplace: chainConfig.marketplace,
    chainId: chainConfig.chainId,
    rpcUrl: chainConfig.rpcUrl,
    abi: chainConfig.abi,
  });
});

chainRouter.get("/listing/:slug", async (req, res) => {
  try {
    const listing = await getOnChainListing(req.params.slug);
    if (!listing) {
      res.status(404).json({ error: "NotFound", message: "No on-chain listing" });
      return;
    }
    res.json({ listing });
  } catch (error) {
    res.status(503).json({
      error: "ChainUnavailable",
      message: error instanceof Error ? error.message : "RPC error",
    });
  }
});

chainRouter.post("/list/:slug", optionalAuth, async (req, res) => {
  const model = findModel(req.params.slug);
  if (!model) {
    res.status(404).json({ error: "NotFound", message: "Model not found in API" });
    return;
  }

  const parsed = listSchema.safeParse({
    ...(req.body ?? {}),
    mode: req.query.mode === "tx" ? "tx" : req.body?.mode,
  });
  if (!parsed.success) {
    res.status(400).json({ error: "ValidationError", details: parsed.error.flatten() });
    return;
  }
  const { mode } = parsed.data;
  const metadataURI =
    parsed.data.metadataURI || `https://NuvyraHub.local/metadata/${model.slug}.json`;
  const priceEth = parsed.data.priceEth ?? model.priceEth;
  const royaltyBps = parsed.data.royaltyBps ?? 500;

  try {
    if (mode === "tx") {
      const tx = buildListTxRequest({
        slug: model.slug,
        metadataURI,
        priceEth,
        royaltyBps,
      });
      res.json({ mode: "tx", tx, model });
      return;
    }

    if (mode === "confirm") {
      if (!parsed.data.txHash || !parsed.data.walletAddress) {
        res.status(400).json({
          error: "ValidationError",
          message: "txHash and walletAddress are required to confirm a wallet listing",
        });
        return;
      }
      if (
        req.user?.walletAddress &&
        !addressesMatch(req.user.walletAddress, parsed.data.walletAddress)
      ) {
        res.status(403).json({
          error: "WalletMismatch",
          message: "The confirming wallet must match the authenticated creator wallet",
        });
        return;
      }

      const listing = await getOnChainListing(model.slug);
      if (!listing || !addressesMatch(listing.creator, parsed.data.walletAddress)) {
        res.status(409).json({
          error: "ListingNotVerified",
          message: "No listing for this slug is owned by the confirming wallet",
        });
        return;
      }
      const transactionMatches = await verifyWalletListTransaction({
        txHash: parsed.data.txHash,
        walletAddress: parsed.data.walletAddress,
        slug: model.slug,
        metadataURI,
        listing,
      });
      if (!transactionMatches) {
        res.status(409).json({
          error: "ListingTransactionNotVerified",
          message: "Transaction is not a successful creator-signed listing for this model",
        });
        return;
      }
      if (
        listing.metadataURI !== metadataURI ||
        listing.priceWei !== parseEther(String(priceEth)).toString() ||
        listing.royaltyBps !== royaltyBps
      ) {
        res.status(409).json({
          error: "ListingMismatch",
          message: "Confirmed listing does not match the model metadata, price, or royalty",
        });
        return;
      }

      model.creatorWallet = listing.creator;
      model.creatorUserId = req.user?.id || model.creatorUserId;
      model.address = `${listing.creator.slice(0, 6)}...${listing.creator.slice(-4)}`;
      model.metadataURI = listing.metadataURI;
      model.listingTxHash = parsed.data.txHash;
      model.onChainListing = { tokenId: listing.tokenId, confirmedAt: new Date().toISOString() };
      model.status = "Active";
      model.updatedAt = new Date().toISOString();

      const user = req.user || store.users.find((u) => addressesMatch(u.walletAddress, listing.creator));
      if (user) {
        user.walletAddress = listing.creator;
        user.role = "CREATOR";
      }

      res.status(201).json({ mode: "confirm", listing, model });
      return;
    }

    const result = await listModelOnChain({
      slug: model.slug,
      metadataURI,
      priceEth,
      royaltyBps,
    });
    res.status(201).json({ mode: "relay", ...result, model });
  } catch (error) {
    res.status(500).json({
      error: "ListFailed",
      message: error instanceof Error ? error.message : "List failed",
    });
  }
});

const acquireSchema = z.object({
  mode: z.enum(["relay", "tx", "confirm"]).default("relay"),
  txHash: z.string().optional(),
  walletAddress: z.string().optional(),
});

chainRouter.post("/acquire/:slug", optionalAuth, async (req, res) => {
  const model = findModel(req.params.slug);
  if (!model) {
    res.status(404).json({ error: "NotFound", message: "Model not found" });
    return;
  }

  const parsed = acquireSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "ValidationError", details: parsed.error.flatten() });
    return;
  }

  try {
    const listing = await getOnChainListing(model.slug);
    if (!listing) {
      res.status(404).json({
        error: "NotListedOnChain",
        message: "Model is not listed on-chain yet. Call POST /api/chain/list/:slug first.",
      });
      return;
    }

    if (parsed.data.mode === "tx") {
      res.json({
        mode: "tx",
        listing,
        tx: buildAcquireTxRequest(listing),
      });
      return;
    }

    if (parsed.data.mode === "confirm") {
      if (!parsed.data.txHash) {
        res.status(400).json({ error: "ValidationError", message: "txHash required" });
        return;
      }
      const acquisition = {
        id: randomUUID(),
        modelSlug: model.slug,
        userId: req.user?.id || "wallet-user",
        walletAddress: parsed.data.walletAddress || "unknown",
        priceEth: model.priceEth,
        txHash: parsed.data.txHash,
        createdAt: new Date().toISOString(),
        onChain: true,
      };
      store.acquisitions.push(acquisition);
      res.status(201).json({ mode: "confirm", acquisition, listing, model });
      return;
    }

    // relay: backend signer pays/acquires (demo)
    const result = await acquireLicenseOnChain(model.slug);
    const acquisition = {
      id: randomUUID(),
      modelSlug: model.slug,
      userId: req.user?.id || "relay-buyer",
      walletAddress: result.buyer,
      priceEth: model.priceEth,
      txHash: result.txHash || `already-owned:${result.buyer}`,
      createdAt: new Date().toISOString(),
      onChain: true,
    };
    store.acquisitions.push(acquisition);
    model.downloadsCount += result.alreadyOwned ? 0 : 1;
    res.status(201).json({
      mode: "relay",
      ...result,
      acquisition,
      model,
      message: result.alreadyOwned
        ? "Wallet already holds license"
        : "License acquired on-chain",
    });
  } catch (error) {
    res.status(500).json({
      error: "AcquireFailed",
      message: error instanceof Error ? error.message : "Acquire failed",
    });
  }
});

module.exports = { chainRouter };
