import type { Metadata } from "next";
import Participation from "@/components/Participation";
import SubHeader from "@/components/SubHeader";
import { routes } from "@/lib/routes";
import "@/styles/sub.css";
import "@/styles/participate.css";

export const metadata: Metadata = { title: "Wallet · Prospecto" };

export default function WalletPage() {
  return <div className="S S-participate"><SubHeader current={routes.wallet} /><main className="page"><Participation /></main></div>;
}
