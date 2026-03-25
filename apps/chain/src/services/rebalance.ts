import { walletClient, publicClient } from '../config.js'
import type { RebalanceRequest, RebalanceResult } from '@lagrangefi/shared'

// Uniswap v3 NonfungiblePositionManager on Arbitrum
const POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' as const

const POSITION_MANAGER_ABI = [
  {
    name: 'decreaseLiquidity',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      name: 'params', type: 'tuple',
      components: [
        { name: 'tokenId', type: 'uint256' },
        { name: 'liquidity', type: 'uint128' },
        { name: 'amount0Min', type: 'uint256' },
        { name: 'amount1Min', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    }],
    outputs: [
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
  {
    name: 'collect',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      name: 'params', type: 'tuple',
      components: [
        { name: 'tokenId', type: 'uint256' },
        { name: 'recipient', type: 'address' },
        { name: 'amount0Max', type: 'uint128' },
        { name: 'amount1Max', type: 'uint128' },
      ],
    }],
    outputs: [
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      name: 'params', type: 'tuple',
      components: [
        { name: 'token0', type: 'address' },
        { name: 'token1', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'tickLower', type: 'int24' },
        { name: 'tickUpper', type: 'int24' },
        { name: 'amount0Desired', type: 'uint256' },
        { name: 'amount1Desired', type: 'uint256' },
        { name: 'amount0Min', type: 'uint256' },
        { name: 'amount1Min', type: 'uint256' },
        { name: 'recipient', type: 'address' },
        { name: 'deadline', type: 'uint256' },
      ],
    }],
    outputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
  {
    name: 'positions',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'nonce', type: 'uint96' },
      { name: 'operator', type: 'address' },
      { name: 'token0', type: 'address' },
      { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { name: 'feeGrowthInside1LastX128', type: 'uint256' },
      { name: 'tokensOwed0', type: 'uint128' },
      { name: 'tokensOwed1', type: 'uint128' },
    ],
  },
] as const

const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

const MAX_UINT128 = 2n ** 128n - 1n
const DEADLINE_BUFFER = 300n // 5 minutes

export async function rebalance(req: RebalanceRequest): Promise<RebalanceResult> {
  const tokenId = BigInt(req.tokenId)
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_BUFFER
  const account = walletClient.account!
  const txHashes: string[] = []

  // 1. Fetch current position
  const position = await publicClient.readContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: 'positions',
    args: [tokenId],
  })
  const liquidity = position[7]

  if (liquidity === 0n) {
    return { success: false, txHashes: [], error: 'Position has no liquidity' }
  }

  // 2. Remove all liquidity
  const decreaseTx = await walletClient.writeContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: 'decreaseLiquidity',
    args: [{
      tokenId,
      liquidity,
      amount0Min: 0n, // TODO: apply slippage tolerance
      amount1Min: 0n,
      deadline,
    }],
  })
  await publicClient.waitForTransactionReceipt({ hash: decreaseTx })
  txHashes.push(decreaseTx)

  // 3. Collect all tokens
  const collectTx = await walletClient.writeContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: 'collect',
    args: [{
      tokenId,
      recipient: account.address,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128,
    }],
  })
  await publicClient.waitForTransactionReceipt({ hash: collectTx })
  txHashes.push(collectTx)

  // 4. Get token balances after collection
  const token0 = position[2] as `0x${string}`
  const token1 = position[3] as `0x${string}`
  const fee = position[4]

  const [balance0, balance1] = await Promise.all([
    publicClient.readContract({ address: token0, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
    publicClient.readContract({ address: token1, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
  ])

  // 5. TODO: swap to correct ratio for new range
  // Ratio calculation depends on new tick range — to be implemented

  // 6. Approve position manager to spend tokens
  const [approveTx0, approveTx1] = await Promise.all([
    walletClient.writeContract({ address: token0, abi: ERC20_ABI, functionName: 'approve', args: [POSITION_MANAGER, balance0] }),
    walletClient.writeContract({ address: token1, abi: ERC20_ABI, functionName: 'approve', args: [POSITION_MANAGER, balance1] }),
  ])
  await Promise.all([
    publicClient.waitForTransactionReceipt({ hash: approveTx0 }),
    publicClient.waitForTransactionReceipt({ hash: approveTx1 }),
  ])
  txHashes.push(approveTx0, approveTx1)

  // 7. Mint new position at new range
  const mintTx = await walletClient.writeContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: 'mint',
    args: [{
      token0,
      token1,
      fee,
      tickLower: req.newTickLower,
      tickUpper: req.newTickUpper,
      amount0Desired: balance0,
      amount1Desired: balance1,
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: account.address,
      deadline,
    }],
  })
  const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintTx })
  txHashes.push(mintTx)

  // Parse new tokenId from Transfer event (ERC721)
  // The new tokenId is emitted as the third topic of the Transfer event
  const transferLog = mintReceipt.logs.find(
    (log) => log.address.toLowerCase() === POSITION_MANAGER.toLowerCase() && log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  )
  const newTokenId = transferLog?.topics[3] ? BigInt(transferLog.topics[3]).toString() : undefined

  return { success: true, txHashes, newTokenId }
}
