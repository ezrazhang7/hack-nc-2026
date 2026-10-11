import SubHeader from '@/components/SubHeader';
import Participation from '@/components/Participation';
import '@/styles/sub.css';
import '@/styles/participate.css';
export default function Page(){return <div className="S"><SubHeader current="/participate/"/><main className="page"><h1>Your startup circle</h1><p>Campus startups · Nessie simulated banking · Solana Devnet</p><Participation/></main></div>;}
