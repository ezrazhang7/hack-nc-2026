import type { Pool,PoolClient } from 'pg';
import {eventMapping} from './projector.js';

export interface ChainEvent {
  programId:string;signature:string;instructionIndex:number;eventIndex:number;slot:string;eventType:string;payload:unknown;
}
export interface EventChain {
  programAddress():string;
  signatures(before?:string,until?:string):Promise<Array<{signature:string}>>;
  finalizedEvents(signature:string):Promise<ChainEvent[]>;
}
export class Indexer {
  constructor(readonly pool:Pool,readonly chain:EventChain,readonly project?:(client:PoolClient,event:ChainEvent,eventId:string)=>Promise<void>) {}
  async ingest(signature:string):Promise<void> {
    const events=await this.chain.finalizedEvents(signature);
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const event of events) {
        const mapping=this.project ? await eventMapping(client,event) : {projectId:null,roundId:null};
        const inserted=await client.query<{id:string}>(`INSERT INTO chain_events
        (chain,program_id,signature,instruction_index,event_index,slot,event_type,payload,confirmation_status,project_id,round_id)
        VALUES('solana',$1,$2,$3,$4,$5,$6,$7,'FINALIZED',$8,$9)
        ON CONFLICT(chain,signature,instruction_index,event_index) DO NOTHING RETURNING id`,
        [event.programId,event.signature,event.instructionIndex,event.eventIndex,event.slot,event.eventType,event.payload,mapping.projectId,mapping.roundId]);
        if(inserted.rows[0] && this.project) await this.project(client,event,inserted.rows[0].id);
      }
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  }
  async backfill():Promise<void> {
    const lock=await this.pool.connect();
    try {
      const acquired=await lock.query<{locked:boolean}>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[`indexer:${this.chain.programAddress()}`]);
      if (!acquired.rows[0]?.locked) return;
      try {
        const state=await this.pool.query<{last_signature:string}>('SELECT last_signature FROM indexer_state WHERE program_id=$1',[this.chain.programAddress()]);
        const until=state.rows[0]?.last_signature;let before:string|undefined;const signatures:string[]=[];
        let complete=false;
        for (let page=0;page<20;page++) {
          const batch=await this.chain.signatures(before,until);
          signatures.push(...batch.map(item=>item.signature));
          if (batch.length<1000) {complete=true;break;}
          before=batch.at(-1)?.signature;
        }
        if (!complete) throw new Error('Indexer backfill exceeded page limit; retain cursor for operator recovery.');
        for (const signature of [...signatures].reverse()) await this.ingest(signature);
        if (signatures[0]) await this.pool.query(`INSERT INTO indexer_state(program_id,last_signature) VALUES($1,$2)
          ON CONFLICT(program_id) DO UPDATE SET last_signature=EXCLUDED.last_signature,updated_at=now()`,[this.chain.programAddress(),signatures[0]]);
      } finally {await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`indexer:${this.chain.programAddress()}`]);}
    } finally {lock.release();}
  }
}
