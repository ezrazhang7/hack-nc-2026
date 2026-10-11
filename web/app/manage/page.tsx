import type { Metadata } from "next";
import Participation from "@/components/Participation";
import SubHeader from "@/components/SubHeader";
import { routes } from "@/lib/routes";
import "@/styles/sub.css";
import "@/styles/participate.css";

export const metadata: Metadata = { title: "Manage Listings · Prospecto" };

export default function ManagePage() {
  return <div className="S S-participate"><SubHeader current={routes.manage} /><main className="page"><Participation mode="manage" /></main></div>;
}
