# Shadhil Builders CRM

The system Shadhil Builders sells villas through. Staff work leads by phone and WhatsApp, take bookings against individual villa units, and give each buyer a read-only view of construction progress. One organization owns all of its data, and the same code serves any number of organizations.

## Language

### Tenancy and staff

**Organization**:
The tenant. One building company's data, walled off from every other company's.
_Avoid_: tenant, workspace, account (an account is a sign-in identity)

**Team**:
A group of staff under one manager, used to route leads.
_Avoid_: group, department

**Project team**:
A team assigned to a project. The team routed to longest ago receives the next lead.
_Avoid_: allocation, squad

**Project staff role**:
An extra responsibility one user holds on one project, such as site engineer.
_Avoid_: permission, assignment

**Assignment rule**:
A priority-ordered rule that decides which staff member receives a new lead from a given source.
_Avoid_: routing table, dispatch rule, auto-assign

**Owner**:
The person who created the organization. Holds every Admin right plus ownership of the company.
_Avoid_: superadmin, root

**Admin**:
Full access to one organization's data.
_Avoid_: superuser

**Manager**:
A staff role that owns leads and runs a team.
_Avoid_: team lead, supervisor

**Sales exec**:
A staff role that owns leads and carries them to a booking.
_Avoid_: agent, rep, salesperson

**Telecaller**:
A staff role that works leads by phone.
_Avoid_: caller, tele-agent

**Engineer**:
Site staff. Posts construction progress photos for their assigned projects and sees nothing commercial.
_Avoid_: contractor, supervisor, site manager

**Customer**:
The buyer. A read-only account tied to the lead that bought, able to see only units with an approved booking, along with those units' phase and progress photos.
_Avoid_: client, buyer, account (for the person)

### Inventory

**Project**:
One development the company is selling.
_Avoid_: site, property, listing

**CMDA**:
Chennai Metropolitan Development Authority. Its approved layout is what assigns plot numbers.
_Avoid_: DTCP (the authority for districts outside Chennai)

**Phase**:
A stage of a project that groups its units and anchors progress reporting, e.g. Foundation October 2026.
_Avoid_: stage, milestone, block

**Unit**:
One villa offered for sale, and the thing a booking is made against. The business says villa, the data says unit: use villa in customer-facing copy and unit in code.
_Avoid_: property, flat, inventory item, listing

**Unit number**:
The number printed on the villa itself, like A-101, and the one the sales team quotes on a call. Deliberately not the plot number.
_Avoid_: door number, address, plot number

**Plot number**:
The CMDA number the villa occupies on the approved layout, from 1 to 125. The plot map locates villas by this number, never by the unit number.
_Avoid_: unit number, survey number

**Plot area**:
The land area of the unit's plot. The screen labels it "Plot sq.ft".
_Avoid_: sqft on its own (always say which area you mean)

**Built-up area**:
The constructed area of the villa, which pricing is calculated from.
_Avoid_: carpet area, super built-up, construction area

**Rate**:
The price per square foot of built-up area.
_Avoid_: unit rate, price per sqft

**Unit price**:
The total for a unit: built-up area times rate. Always calculated, never typed in.
_Avoid_: total, cost, value

**Project option**:
A value the project allows for a choice such as facing or BHK.
_Avoid_: variant, config, attribute

### Selling

**Booking**:
A lead's commitment to one unit, carrying the amount that was agreed.
_Avoid_: reservation, sale, deal, order

**Booking state**:
Where a booking stands: hold, token, approved, rejected or cancelled.
_Avoid_: booking status, stage

**Hold**:
A short-lived claim on a unit before any money has changed hands.
_Avoid_: reservation, lock, block

**Token**:
The advance a buyer pays to secure a unit while paperwork completes.
_Avoid_: deposit, advance, booking fee, down payment

**List amount**:
The unit price at the moment of booking, kept as the baseline the negotiation is measured against.
_Avoid_: sticker price, MRP

**Negotiated rate**:
The per-square-foot rate actually agreed with the buyer.
_Avoid_: discount, deal rate

**Booking amount**:
What the buyer is actually charged: the negotiated amount when there is one, otherwise the list amount.
_Avoid_: final price, sale price

### Demand

**Lead**:
A prospective buyer under pursuit, belonging to exactly one project.
_Avoid_: prospect, enquiry, contact, customer

**Lead state**:
Where a lead sits in the pipeline, from new through visit and negotiation to won or lost.
_Avoid_: status, stage, phase (a phase belongs to a project, not a lead)

**RNR**:
Ring, no response. The telecaller called and nobody picked up. It ends the pursuit rather than queueing a retry, so a lead left in RNR has no owner until an Admin reassigns it.
_Avoid_: unreachable, no answer, missed

**Lead fact**:
One claimed attribute of a lead, such as budget or family size, along with the evidence behind it.
_Avoid_: field, attribute, property

**Fact band**:
How much a lead fact is trusted: verified, probable or possible.
_Avoid_: confidence, score, certainty

**Evidence**:
Why a lead fact is believed, recorded once per independent source.
_Avoid_: proof, source, citation

**Method**:
Who observed a lead fact, such as a WhatsApp profile name or an enquiry form.
_Avoid_: channel, source

**Activity**:
A logged interaction on a lead: a call, note, status change, visit, email or assignment.
_Avoid_: log, event, timeline item

**Site visit**:
A lead's scheduled trip to the site, with its own outcome.
_Avoid_: appointment, tour, meeting

**Reminder**:
A pre-visit or follow-up nudge the system sends about a lead.
_Avoid_: notification, alert

### Conversation

**Message**:
One WhatsApp or in-app message inside a single thread.
_Avoid_: chat, text, communication

**Unknown contact**:
A WhatsApp number that messaged in but has not become a lead yet.
_Avoid_: stranger, unknown user, orphan

### Build

**Progress photo**:
A dated photo of a phase under construction, shown to the buyers of units in that phase.
_Avoid_: site photo, image, attachment
