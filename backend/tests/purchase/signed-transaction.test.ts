import { describe, expect, test } from 'vitest';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { validateSigned } from '../../src/purchase/solana/signed-transaction.js';
import { founder, sign, testIntent } from './helpers.js';

describe('exact wallet-signed messages', () => {
  test('accepts both required signatures', () => {
    const intent = testIntent();
    expect(validateSigned(intent, sign(intent)).length).toBeGreaterThan(0);
  });
  test('rejects a missing founder signature', () => {
    const intent = testIntent();
    expect(() => validateSigned(intent, intent.transaction)).toThrow(/exact prepared/);
  });
  test('rejects substituted instructions even with valid wallet signatures', () => {
    const intent = testIntent();
    const tx = VersionedTransaction.deserialize(Buffer.from(sign(intent), 'base64'));
    tx.message.compiledInstructions[0]!.data[4] = 9;
    tx.sign([founder]);
    expect(() => validateSigned(intent, Buffer.from(tx.serialize()).toString('base64'))).toThrow();
  });
  test('rejects a different blockhash', () => {
    const intent = testIntent();
    const tx = VersionedTransaction.deserialize(Buffer.from(sign(intent), 'base64'));
    tx.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
    expect(() => validateSigned(intent, Buffer.from(tx.serialize()).toString('base64'))).toThrow();
  });
  test('rejects forged signatures and noncanonical encoding', () => {
    const intent = testIntent();
    const tx = VersionedTransaction.deserialize(Buffer.from(sign(intent), 'base64'));
    tx.signatures[1]!.fill(0);
    expect(() => validateSigned(intent, Buffer.from(tx.serialize()).toString('base64'))).toThrow();
    expect(() => validateSigned(intent, sign(intent) + '\n')).toThrow();
    expect(() => validateSigned(intent, 'AA==')).toThrow();
  });
});
