# Stub Quoting App — knowledge pack

This is a tiny stand-in for a real app, used to develop the demo service itself.
Everything below is fictional.

## What the app does

The Stub Quoting App turns an RFP for low-voltage switchboards into a priced
quote. It has three screens:

- **Projects**: the list of quotes. The demo project is "Al-Marsa Business Park — Phase 2".
- **Boards**: the switchboards the engine found for the project, with the
  short-circuit withstand check. One board (DB-P1) was re-selected from 25 kA to
  36 kA because the bus fault rating was 36 kA; that is shown as a flag.
- **Pricing**: the negotiated markup (18 % by default) and the live totals.

## Facts

- Client: Marsa Developments. Consultant: Delta Consulting Engineers. Currency: EGP.
- Boards in the demo project: MDB-01 (2500 A, cost EGP 1,860,000) and EMDB-01 (1000 A, cost EGP 742,000).
- Cost total for the two boards: EGP 2,602,000.
- Selling total at 18 % markup: EGP 3,070,360. At 20 %: EGP 3,122,400.
- VAT is 14 % and is added on top of the selling total.
- Prices are supply only: no installation, freight or site labour.

## Not covered

Integrations, user accounts, pricing plans and delivery times are not part of
this demo. Say so plainly if asked.
