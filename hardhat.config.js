require("@nomicfoundation/hardhat-toolbox");
require("solidity-coverage");
require("dotenv").config({ quiet: true });

/**
 * Testnet RPC URLs and private keys are read from environment variables so that
 * secrets are never committed to the repository.
 *
 *   SEPOLIA_RPC_URL     – e.g. https://sepolia.infura.io/v3/<key>
 *   POLYGON_AMOY_RPC_URL – e.g. https://polygon-amoy.g.alchemy.com/v2/<key>
 *   DEPLOYER_PRIVATE_KEY – 0x-prefixed deployer account private key
 *   ETHERSCAN_API_KEY   – for contract verification on Etherscan / Polygonscan
 */

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY
  ? [process.env.DEPLOYER_PRIVATE_KEY]
  : [];

/** @type import("hardhat/config").HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      evmVersion: "cancun",
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    ...(process.env.SEPOLIA_RPC_URL && {
      sepolia: {
        url: process.env.SEPOLIA_RPC_URL,
        accounts: DEPLOYER_PRIVATE_KEY,
        chainId: 11155111,
      },
    }),
    ...(process.env.POLYGON_AMOY_RPC_URL && {
      amoy: {
        url: process.env.POLYGON_AMOY_RPC_URL,
        accounts: DEPLOYER_PRIVATE_KEY,
        chainId: 80002,
      },
    }),
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
  mocha: {
    timeout: 60000,
  },
};
