/**
 * Getting Started (audit L-14, decision D-7) — the Help page linked
 * from the account menu. One small page, real content only: the five
 * steps below are the existing flows, in the order a new admin
 * actually does them. No invented tutorials. The in-app Integration
 * Guide (Settings → Integration Guide) covers connecting a product
 * website; this page links to it instead of duplicating it.
 */
import { Link } from "@tanstack/react-router";
import { PageHeader } from "../lib/section-kit";
import { Card } from "./primitives";

const STEPS: { title: string; to: string; linkLabel: string; body: string }[] = [
  {
    title: "1. Create a product",
    to: "/products",
    linkLabel: "Products",
    body: "Add the product you sell, then open it to add its features and packages — features and packages belong to one product each, never to a global list.",
  },
  {
    title: "2. Add a customer",
    to: "/customers",
    linkLabel: "Customers",
    body: "Add the customer with an email or a phone number. The same email or phone never makes a second customer — duplicates are blocked and shown to you instead.",
  },
  {
    title: "3. Create an order",
    to: "/orders",
    linkLabel: "Orders",
    body: "Create the order from a package or as a custom offer. Payments can be a single payment or installments, with editable dates; each installment shows paid versus due.",
  },
  {
    title: "4. Record a payment",
    to: "/payment-review",
    linkLabel: "Payment review",
    body: "Record the payment when the money arrives. A manual payment claim stays unverified until staff verify the actual receipt — nothing is shown as paid before that.",
  },
  {
    title: "5. Manage licenses and files",
    to: "/licenses",
    linkLabel: "Licenses",
    body: "Licenses activate per the order's own rule — on full payment, on a percentage paid, or on a fixed date. Files live in the Media Library, and every upload spot in the app opens the same library picker.",
  },
];

export function GettingStartedPage() {
  return (
    <section aria-labelledby="getting-started-heading">
      <PageHeader
        breadcrumb={[{ label: "Getting Started" }]}
        title="Getting Started"
        help="Five steps from an empty StackMate to a first paid order"
      />
      <Card title="Five steps to your first order">
        <ol className="sm-stack">
          {STEPS.map((step) => (
            <li key={step.to}>
              <strong>{step.title}</strong> — {step.body}{" "}
              <Link to={step.to as never}>{step.linkLabel} →</Link>
            </li>
          ))}
        </ol>
        <p className="sm-hint">
          Connecting your own website to StackMate — license checks,
          webhooks and push events — is covered by the{" "}
          {/* The `as never` casts below are the codebase's established
              pattern for route strings (see QuickNav's go()): this
              page has no route yet, so the router's contextual Link
              typing has no mount point to resolve against. */}
          <Link to={"/settings/integration-guide" as never}>Integration Guide</Link>.
          Customer issues go to{" "}
          <Link to={"/tickets" as never}>Support Tickets</Link>.
        </p>
      </Card>
    </section>
  );
}
