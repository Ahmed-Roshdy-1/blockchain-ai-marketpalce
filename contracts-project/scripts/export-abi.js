const fs = require("fs");
const path = require("path");

async function main() {
  const artifactPath = path.join(
    __dirname,
    "..",
    "artifacts",
    "contracts",
    "NuvyraHubMarketplace.sol",
    "NuvyraHubMarketplace.json",
  );

  if (!fs.existsSync(artifactPath)) {
    throw new Error("Compile contracts first: npm run compile");
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const sharedDir = path.join(__dirname, "..", "..", "shared");
  fs.mkdirSync(sharedDir, { recursive: true });

  const abiOut = {
    contractName: "NuvyraHubMarketplace",
    abi: artifact.abi,
  };

  fs.writeFileSync(
    path.join(sharedDir, "NuvyraHubMarketplace.abi.json"),
    JSON.stringify(abiOut, null, 2),
  );

  const targets = [
    path.join(__dirname, "..", "..", "project", "backend", "src", "abi"),
    path.join(__dirname, "..", "..", "project", "src", "abi"),
  ];

  for (const dir of targets) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "NuvyraHubMarketplace.json"),
      JSON.stringify(abiOut, null, 2),
    );
  }

  console.log("Exported ABI to shared/, project/backend/src/abi, project/src/abi");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
