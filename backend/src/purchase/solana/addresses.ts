import { PublicKey } from '@solana/web3.js';
import { AppError } from '../http/errors.js';

export function publicKey(value: string): PublicKey {
  try { return new PublicKey(value); }
  catch { throw new AppError('INVALID_INPUT', 'Invalid Solana address.'); }
}
export function projectAddresses(programId: PublicKey, projectId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
    throw new AppError('INVALID_INPUT', 'Project ID must be a UUID.');
  }
  const bytes = Buffer.from(projectId.replaceAll('-', ''), 'hex');
  const derive = (name: string, seed: Buffer) => PublicKey.findProgramAddressSync([Buffer.from(name), seed], programId)[0];
  const project = derive('project', bytes);
  return {
    bytes, project, receiptMint: derive('receipt_mint', project.toBuffer()),
    projectVault: derive('project_vault', project.toBuffer()),
    founderRewardVault: derive('founder_reward_vault', project.toBuffer()),
    config: PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0],
  };
}
