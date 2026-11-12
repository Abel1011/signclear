// Client-safe: the script of the 90-second story (captions, screens, what to press when the judge takes over).
export type TourScreen = "client" | "desk";
export type TourStep = {
  id: string;
  act: 1 | 2;
  screen: TourScreen;
  who: string;
  title: string;
  caption: string;
  /** What the judge would press to do this step by hand ("take over"). */
  manual: string;
  paypal?: boolean;
};

export const TOUR_STEPS: TourStep[] = [
  {
    id: "fraud",
    act: 1,
    screen: "client",
    who: "María (client)",
    title: "Fraud caught before she signs",
    caption: "Luis's return sends María's $7,729 refund to account ****9931 — hers ends in 1234. Approval is blocked before she signs; PayPal holds nothing.",
    manual: "Read the red line on María's screen; switch her language to Español.",
  },
  {
    id: "corrected",
    act: 1,
    screen: "desk",
    who: "Luis (preparer)",
    title: "Luis uploads the corrected return",
    caption: "Refund now goes to ****1234. The rules re-check every line against María's answers: all match.",
    manual: "On Luis's desk press “Use the sample return”.",
  },
  {
    id: "approve",
    act: 1,
    screen: "client",
    who: "María (client)",
    title: "María approves → PayPal AUTHORIZES the fee",
    caption: "A real PayPal sandbox order is created and authorized with a vaulted sandbox wallet. The $250 is held, not charged.",
    manual: "On María's screen press Approve and pay with PayPal.",
    paypal: true,
  },
  {
    id: "file",
    act: 1,
    screen: "desk",
    who: "Luis (preparer)",
    title: "Luis files with the IRS",
    caption: "He records the e-file Submission ID (EFIN + year + day). The fee stays on hold.",
    manual: "On Luis's desk record the Submission ID (“generate one”).",
  },
  {
    id: "early",
    act: 1,
    screen: "desk",
    who: "Luis (preparer)",
    title: "Luis asks to be paid now → refused",
    caption: "The capture request reaches the money guardian. No IRS confirmation on file, so the code refuses — no PayPal call is made.",
    manual: "On Luis's desk press “Ask to be paid now”.",
  },
  {
    id: "ack",
    act: 1,
    screen: "desk",
    who: "Luis (preparer)",
    title: "IRS acknowledgment verified → PayPal CAPTURES",
    caption: "A sample IRS acknowledgment for this Submission ID is checked by code (status, EFIN, taxpayer, dates). Only then is the fee captured.",
    manual: "On Luis's desk upload the sample IRS acknowledgment.",
    paypal: true,
  },
  {
    id: "short",
    act: 2,
    screen: "client",
    who: "María (client)",
    title: "Act 2 · Her refund arrives $3,000 short",
    caption: "María approved $7,729; $4,729 reached her bank. Clara opens an investigation and explains it in her language.",
    manual: "On María's screen report $4,729 received.",
  },
  {
    id: "transcript",
    act: 2,
    screen: "client",
    who: "María (client)",
    title: "The IRS transcript proves it was diverted",
    caption: "The IRS record shows the full $7,729 was paid with no debts deducted — but the filed return split $3,000 to ****9931 (a Form 8888 María never approved). Her fee refund is proposed.",
    manual: "On María's screen upload the IRS transcript.",
  },
  {
    id: "clock",
    act: 2,
    screen: "desk",
    who: "Clock",
    title: "Luis has 72 hours to explain",
    caption: "He doesn't answer with evidence (simulated clock: +73 h). The proposal stands.",
    manual: "Fast-forward 72 h.",
  },
  {
    id: "refund",
    act: 2,
    screen: "client",
    who: "María (client)",
    title: "María confirms → PayPal REFUNDS the fee",
    caption: "The code checks the IRS record, the 72 h and her confirmation, then PayPal refunds the captured $250.",
    manual: "On María's screen press “I confirm…”.",
    paypal: true,
  },
];
