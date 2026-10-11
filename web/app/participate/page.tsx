import SubHeader from "@/components/SubHeader";
import Markets from "@/components/markets/Markets";
import "@/styles/sub.css";
import "@/styles/participate.css";
import "@/styles/markets.css";

export const metadata = { title: "Invest · Prospecto" };

export default function Page() {
  return (
    <div className="S S-markets">
      <SubHeader current="/participate/" />
      <main className="page"><Markets /></main>
    </div>
  );
}
