import { createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { AppError } from '../http/errors.js';
import type { Intent } from '../tokenization/types.js';

export function validateSigned(intent: Intent, encoded: string): Uint8Array {
  try {
    if (encoded.length > 2000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('encoding');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded || bytes.length > 1232) throw new Error('size');
    const tx = VersionedTransaction.deserialize(bytes);
    if (!Buffer.from(tx.serialize()).equals(bytes)) throw new Error('noncanonical');
    const message = Buffer.from(tx.message.serialize());
    const expected = Buffer.from(intent.message, 'base64');
    if (expected.length !== message.length || !timingSafeEqual(expected, message)) throw new Error('message');
    for (let index = 0; index < tx.message.header.numRequiredSignatures; index++) {
      const address = tx.message.staticAccountKeys[index];
      const signature = tx.signatures[index];
      if (!address || !signature) throw new Error('signature');
      const key = createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), address.toBuffer()]),
        format: 'der', type: 'spki',
      });
      if (!verify(null, message, key, signature)) throw new Error('signature');
    }
    const signature = tx.signatures[0];
    if (!signature || bs58.encode(signature) !== intent.signature) throw new Error('payer');
    return bytes;
  } catch {
    throw new AppError('INVALID_TRANSACTION', 'Sign the exact prepared transaction with all required wallets.');
  }
}
