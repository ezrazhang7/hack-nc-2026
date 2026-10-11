import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {NessieBank,profileSchema} from '../src/purchase/banking/adapter.js';
import {baseline,verifyCapability} from '../src/purchase/banking/probe.js';
// Read-only capability probe. Create the single tagged mock transfer in the provider's sandbox first.
const [mode,candidateFile,baselineFile,...args]=process.argv.slice(2);
if(!candidateFile || !baselineFile || !process.env.NESSIE_API_KEY) throw new Error('Usage: nessie:probe baseline candidate.json baseline.json payer payee, or verify candidate.json baseline.json transfer tag dollars create-response.json output.json');
try {
  const raw=JSON.parse(await readFile(candidateFile,'utf8'));
  // Candidate settings are hypotheses for read-only calls; they never enable funding.
  const candidate=profileSchema.parse({...raw,capabilitiesVerified:true});
  if(candidate.definitiveNoEffectHttpStatuses.length) throw new Error('No-effect semantics require separate evidence. Leave the list empty.');
  const bank=new NessieBank(candidate,process.env.NESSIE_API_KEY);
  if(mode==='baseline') {
    await writeFile(baselineFile,JSON.stringify(await baseline(bank,args[0]!,args[1]!),null,2),{flag:'wx',mode:0o600});
    console.log('Private baseline saved. No bank write was made.');
  } else if(mode==='verify') {
    const verified=await verifyCapability(bank,JSON.parse(await readFile(baselineFile,'utf8')),args[0]!,args[1]!,Number(args[2]),JSON.parse(await readFile(args[3]!,'utf8')),candidate.createEnvelope);
    if(verified.creationStatus!==verified.terminalStatus && !candidate.pendingStatuses.includes(verified.creationStatus)) throw new Error('Creation status was not an observed pending status.');
    if(!args[4]) throw new Error('An output path is required.');
    await writeFile(args[4],JSON.stringify({...candidate,verifiedAt:verified.verifiedAt,capabilitiesVerified:true,verificationReference:`sandbox-probe:${randomUUID()}`,successStatuses:[verified.terminalStatus],pendingStatuses:verified.creationStatus===verified.terminalStatus ? [] : [verified.creationStatus],rejectedStatuses:[]},null,2),{flag:'wx',mode:0o600});
    console.log('Verified profile saved privately. One matching terminal transfer and both balance changes were observed.');
  } else throw new Error('Unknown probe mode.');
} catch {console.error('Capability probe failed. Funding remains disabled; no provider write was made.');process.exitCode=1;}
