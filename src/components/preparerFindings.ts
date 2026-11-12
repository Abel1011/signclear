// Preparer-facing wording for client-review findings. rules.ts writes to the CLIENT ("Your refund would go…");
// the preparer desk needs the same fact stated to the preparer. Derived per rule from the finding (client-safe).
import type { Finding } from "@/lib/rules";

export function preparerText(f: Pick<Finding, "rule" | "severity" | "rowKey" | "message">): string {
  const en = f.message.en;
  const n = (re: RegExp) => re.exec(en)?.slice(1) ?? [];
  switch (f.rule) {
    case "R3": {
      if (f.severity === "CLARIFY") return "Refund split across several accounts (Form 8888) — the client must confirm they are all hers.";
      const [to, client] = n(/account \*{4}(\w+); you gave us \*{4}(\w+)/);
      return to ? `Refund routed to ****${to} — client's account is ****${client}.` : en;
    }
    case "R5": {
      const [ret, told] = n(/lists (\d+) dependents; you told us (\d+)/);
      return ret ? `Return claims ${ret} dependents — client reported ${told}.` : en;
    }
    case "R1":
      return "Paid preparer section is empty or marked self-prepared.";
    case "R2":
      return "Preparer PTIN on the return is missing or isn't yours.";
    case "R8":
      return "Taxpayer name or SSN last 4 on the return differ from the client's ID.";
    case "R6":
      if (/child tax credit/i.test(en)) return "Child tax credit claimed — client listed no children under 17.";
      if (/education/i.test(en)) return "Education credit claimed — client didn't report education expenses.";
      if (/fuel/i.test(en)) return "Fuel tax credit (Form 4136) claimed — client didn't report it.";
      return en;
    case "R6b":
      return "ITIN filer: EITC/CTC/ACTC require a valid SSN (the $500 other-dependent credit is still allowed).";
    case "R4":
      return "Schedule C business on the return — client didn't report self-employment.";
    case "R4a":
      return "Schedule C income is outside the range the client reported.";
    case "R4b":
      return "Schedule C shows a loss — client reported earnings.";
    case "R7":
      return /withholding/i.test(en) ? "Withholding differs from the client's forms." : "Wages differ from the client's W-2.";
    case "R10":
      return "Form 1040 totals don't add up.";
    case "R11":
      return "Form 8879 amounts don't match the return.";
    case "R12":
      return "Form 8879 is missing or blank.";
    case "R14":
      return en
        .replace(/your account/g, "the client's account")
        .replace(/The version you approved/g, "The version the client approved")
        .replace(/after you approved it/g, "after the client approved it")
        .replace(/\byou approved\b/g, "the client approved");
    default:
      return en.replace(/^Your return lists/, "Return lists").replace(/you told us/, "client said");
  }
}
