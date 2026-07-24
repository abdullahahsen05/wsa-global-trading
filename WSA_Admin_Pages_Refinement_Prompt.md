# Codex Prompt — Refine All Admin Directory & Management Pages

You are refining the following WSA Global admin pages shown in the attached screenshots:

1. User Management
2. Trader Profiles
3. Account Supervision
4. Broker Catalog
5. CRM

Use the attached screenshots as evidence of the current layout and spacing problems.

This is a UI-only refinement.

Do not change functionality, API behavior, routes, queries, mutations, Supabase logic, React Query keys, permissions, role logic, state, handlers, form behavior, dialog behavior, table data, actions, labels, or conditional rendering.

Do not remove any button, field, filter, status, metric, table, row, note, action, or workflow.

Do not add new product functionality.

The objective is to make all five pages feel like one coherent enterprise operations system rather than separate generic SaaS pages made from large panels and small cards.

The final design must follow the same refined visual language already approved for the Admin Overview page:

- near-black background
- WSA yellow accent
- lime only for positive or verified states
- red only for danger, loss, failure, or risk
- warm off-white text
- muted warm gray text
- thin structural borders
- 0–4px panel radius
- 4–6px control radius
- compact status badges
- flat tables
- row-based lists
- definition rails
- connected metric strips
- content-driven section heights
- minimal shadows
- no glassmorphism
- no bento layout
- no rounded card clusters
- no oversized empty black regions
- no unnecessary panel-inside-panel patterns
- no pill-shaped navigation or buttons
- no scale-on-hover

---

# 1. Shared problems visible across all pages

The screenshots show the same recurring issues:

1. The pages rely too much on one giant selected-record panel.
2. Metric values are wrapped inside separate mini cards.
3. Large bordered containers hold very little content.
4. Filters appear inside another oversized rounded container.
5. Empty states occupy too much space and look decorative.
6. Main content often uses only the upper-left part of the viewport.
7. Large unused black space remains below selected content.
8. Page structures are inconsistent across Users, Traders, Supervision, Broker Catalog, and CRM.
9. Some pages use tables; others use large profile cards for similar information.
10. Role, segment, status, and metadata are repeated in multiple badges and boxes.
11. Actions appear scattered rather than grouped into clear toolbars.
12. Page spacing is overly vertical and content density is too low.
13. Forms are pushed into narrow side columns.
14. Selected-record details do not use available width efficiently.
15. The page heading, stats, filters, selected record, and actions do not feel connected.

Fix these issues through shared layout and component improvements rather than adding page-specific hacks.

---

# 2. Global page structure for all five pages

Every page should follow this consistent shell:

```text
Page heading
Contextual actions
Thin divider
Connected summary rail
Flat filter / tab toolbar
Primary workspace
```

Recommended structure:

```text
Header:
- eyebrow
- title
- description
- actions aligned right

Summary rail:
- one continuous bordered strip
- internal vertical dividers
- no separate cards

Filter toolbar:
- compact tabs / filters
- no oversized rounded wrapper

Primary workspace:
- table/list on the left
- selected detail or contextual editor on the right
- or one full-width detail view when the page only needs one selected entity
```

Use consistent desktop proportions:

- directory/list + detail: approximately `minmax(0, 1.2fr) minmax(340px, 0.8fr)`
- large table + side form: approximately `minmax(0, 1.8fr) minmax(320px, 0.7fr)`
- profile details + activity: approximately `minmax(0, 1fr) minmax(0, 1fr)`

At tablet widths:

- stack secondary panels beneath primary content
- preserve full-width tables
- avoid narrow compressed side columns

At mobile widths:

- one column
- tables scroll internally
- action toolbars wrap predictably
- selected detail moves below the list
- no clipped fields or badges

---

# 3. Shared page header

All five pages must use the same header system.

Use:

- 10–11px uppercase yellow eyebrow
- 28–32px page title
- 13–15px muted description
- right-aligned action toolbar
- 20–24px bottom spacing
- thin divider beneath the header

Actions:

- Search
- Import
- Add user
- New note
- Verify selected
- other existing actions

These must use a compact rectangular button system:

- 38–42px height
- 4–6px radius
- no pill shape
- primary action yellow
- secondary actions dark with neutral border
- no oversized gaps
- no scale hover

Do not wrap page headers in panels.

---

# 4. Connected summary rail

The top metrics on all pages should use one continuous strip.

Examples:

User Management:
- Total users
- Admins
- Traders
- Partners
- Pending
- Suspended

Trader Profiles:
- Funded
- At risk
- CRM notes

Account Supervision:
- Accounts
- Connected
- Pending
- Inactive
- Open trades

CRM:
- Profiles
- Traders
- Platform users
- Active subscriptions

Use:

- one outer border
- internal vertical dividers
- 56–72px height
- label left
- value right or aligned beneath
- tabular numerals
- semantic color only on the value where useful
- no icon unless already available and useful
- no card per metric
- no large empty padding

Mobile:

- horizontal scroll or 2-column wrap
- preserve divider logic
- avoid tiny unreadable cells

---

# 5. Filter and tab toolbar

Current filter groups are too large and too boxed.

Refine to:

- flat toolbar
- compact rectangular tabs
- 34–38px height
- 4px radius
- active yellow fill or yellow underline
- inactive dark background with subtle border
- 6–8px gaps
- no oversized rounded container
- no pill cloud
- no excessive padding around the group

Examples:

User Management:
- All
- Traders
- Admins
- Partners
- Pending
- Suspended

Trader Profiles:
- All segments
- Funded
- Evaluation
- At risk
- VIP

Account Supervision:
- All
- Connected
- Pending
- Disconnected
- Restricted
- Inactive

CRM:
- Contacts
- Profile
- Billing
- Activity

Preserve all filters, counts, and click behavior.

---

# 6. User Management page

Current issues:

- the selected profile panel spans nearly the full page width
- four profile attributes are inside four separate mini cards
- status controls, role controls, and partner assignment are scattered vertically
- large empty area remains to the right and below
- selected user data is not presented as an admin workflow
- filter toolbar is oversized
- profile actions are not visually grouped

Refine into a real user administration workspace.

Recommended desktop layout:

```text
Summary rail
Filter toolbar
User directory / list        Selected user inspector
```

If the source already has only the selected user panel and no visible list on this route, preserve functionality but structure the selected profile as a two-column admin inspector:

Left main column:
- name
- email
- status and role summary
- profile metadata
- status actions
- role actions

Right contextual column:
- assignment
- account relationship
- audit note / explanatory copy
- any existing contextual controls

Do not invent new data.

Selected profile header:

- eyebrow
- user name
- email
- status badge
- role badge
- actions aligned consistently

Replace four mini cards with a definition matrix:

```text
Status        ACTIVE
Segment       EVALUATION
Joined        22/07/2026
Role          TRADER
```

Use:

- one bordered section
- 2-column layout
- internal dividers
- no individual rounded boxes

Status controls:

- grouped under `Account status`
- Set pending
- Suspend
- existing status actions
- helper copy aligned beside or below
- no floating unrelated buttons

Role controls:

- grouped under `Role and access`
- current role clearly shown
- Make PARTNER
- Make ADMIN
- preserve all actions
- use compact action toolbar

Assigned partner:

- use a full-width field section
- label, select, and helper
- do not leave the select isolated at the bottom-left of a huge panel

The whole page should size to content and should not create a giant empty selected-profile box.

---

# 7. Trader Profiles page

Current issues:

- selected trader panel occupies too much space
- metric data is split into four mini cards
- empty notes state becomes a large decorative box
- the page has large unused area below
- profile content and notes are not balanced
- filters are inside an oversized rounded wrapper

Recommended layout:

```text
Summary rail
Segment toolbar
Trader list / selected trader       Latest notes / activity
```

If the page does not have a visible list in the current implementation, preserve its behavior and use:

```text
Selected trader summary | Latest notes
```

Desktop ratio:

- `minmax(0, 1.15fr) minmax(340px, 0.85fr)`

Selected trader:

- name
- email
- segment badge
- compact metadata matrix
- accounts
- equity
- last active
- profile state

Replace the four mini cards with one connected definition grid.

Latest notes:

- no giant empty-state card
- use a compact section
- if notes are empty:

```text
No notes yet
This trader has no CRM notes yet.
```

- keep the empty state near the top
- no large decorative icon block
- no fixed minimum height
- use natural content height

If notes exist:

- show row-based notes
- date
- author
- note text
- separators
- no note cards

Preserve New note and Search actions.

---

# 8. Account Supervision page

Current issues:

- selected account panel is too wide and too empty
- six account values are presented as separate mini cards
- actions appear as a loose row
- the filter bar is oversized
- there is a very large unused area below
- selected account data does not feel like an operational inspector

Recommended structure:

```text
Summary rail
Status filter toolbar
Account directory / table        Selected account inspector
```

If a visible directory is not currently part of this page, preserve behavior and improve the selected-account area into a compact inspector.

Selected account header:

- eyebrow
- account name
- broker
- status badge
- selected account action area

Replace all metric boxes with a definition matrix:

```text
Balance        $0
Equity         $0
Drawdown       0.0%
Open trades    0
Floating P&L   $0
Last updated   24/07/2026, 03:57:11
```

Use:

- one connected grid
- 2 or 3 columns on desktop
- internal dividers
- no individual rounded cards

Action toolbar:

- Store MT5 credentials
- Sync account
- Deactivate
- Remove from queue
- preserve every action
- visually separate primary operational action from secondary actions
- keep destructive action visually restrained until hover
- no scattered buttons

Remove fixed or excessive panel height.

The selected account panel should end shortly after the action toolbar unless more content is present.

---

# 9. Broker Catalog page

Current issues:

- many nested bordered panels
- provider table, add-provider form, selected-provider section, empty state, and server form all feel like separate cards
- the right form column is narrow
- selected provider area uses too much vertical space
- empty state is oversized
- add-provider form and add-server form do not follow one form system
- action hierarchy is inconsistent

Recommended layout:

Top:
- page header
- admin-configured catalog notice as slim information strip

Primary workspace:

```text
Broker providers table      Add broker provider
```

Desktop ratio:

- `minmax(0, 1.8fr) minmax(320px, 0.7fr)`

Selected provider workspace:

```text
Configured servers          Add configured server
```

Use the same ratio.

Admin-configured catalog notice:

- slim horizontal notice
- yellow left rail
- small icon
- title and description
- no large promotional panel

Broker providers table:

- flat table
- no extra nested panel
- provider
- platforms
- servers
- status
- action
- compact Manage action
- right-align numeric columns

Add broker provider form:

- structured form section
- consistent labels and controls
- rectangular inputs
- platform options aligned cleanly
- primary action at bottom
- no empty tall side panel
- section height should follow content

Selected provider header:

- provider name
- supported platforms
- actions right aligned
- Deactivate provider
- Refresh list
- preserve behavior

Configured servers:

- if empty, compact inline empty state
- no giant empty card
- if populated, use table/list rows
- server name
- platform
- source/status if existing
- row actions if existing

Add configured server:

- same field and action system as Add broker provider
- no different radius or padding system

---

# 10. CRM page

Current issues:

- large two-panel layout with little content
- selected profile data uses four mini cards
- activity empty state is oversized
- top tabs are boxed buttons
- page leaves a large empty lower area
- selected profile and recent activity are not balanced
- tags and metadata create unnecessary small boxes

Recommended structure:

```text
CRM tabs
Summary rail
Selected profile            Recent activity
```

CRM tabs:

- use a flat underline tab bar
- Contacts
- Profile
- Billing
- Activity
- active tab with yellow underline
- no boxed tab buttons

Selected profile:

- eyebrow
- name
- email
- status / role badges
- metadata definition grid:
  - Segment
  - Team
  - Linked accounts
  - Subscription
- no mini cards
- use dividers

Tag such as `Top performer`:

- compact badge
- do not give it a large separate row unless necessary

Footer:

- Last active aligned left
- Open full profile aligned right
- one divider above

Recent activity:

- title
- description
- Open activity action
- list or timeline rows
- if empty:
  - compact empty state
  - no giant inner empty-state box
  - no decorative oversized icon
- natural content height

The CRM page should not force both columns to be very tall when there is no activity.

---

# 11. Shared detail matrix pattern

Create or reuse one consistent detail matrix pattern across:

- User Management
- Trader Profiles
- Account Supervision
- CRM
- Broker Catalog contextual metadata

Visual rules:

- one outer border
- no radius above 4px
- internal vertical and horizontal dividers
- 2–4 columns depending on width
- label 10–11px uppercase muted
- value 13–16px semibold
- 16–18px padding
- responsive stacking
- no card per metric

Do not create a new shared component only because the pattern repeats unless the repository architecture supports it cleanly.

A page-local helper is acceptable if changing a shared primitive would create risk.

---

# 12. Shared empty state pattern

All empty states must be compact and operational.

Use:

- 16–24px padding
- optional 28–36px icon
- title
- one-line description
- optional existing action
- no large fixed height
- no rounded card
- no dashed decorative border unless the existing design contract requires it
- left aligned in side panels
- centered only when an entire page is empty

Examples:

- No notes yet
- No configured servers
- No activity yet
- No matching profiles

Do not leave blank panels.

---

# 13. Shared form system

All forms on these pages must use the same style.

Inputs/selects:

- 46–50px height
- 4–6px radius
- neutral dark background
- subtle border
- 14px text
- yellow focus border
- no shadows

Labels:

- 10–11px uppercase
- muted
- controlled tracking
- 7–9px gap

Checkboxes:

- align label and control properly
- no random browser-blue emphasis if the project already supports accent styling
- do not add dependencies

Form actions:

- primary action at bottom or right
- consistent height
- no oversized empty form panels
- helper copy directly below related field

---

# 14. Shared table system

Use one consistent table style across:

- users
- traders
- accounts
- broker providers
- configured servers
- CRM contacts
- any selected lists

Rules:

- no rounded row cards
- 46–50px rows
- compact uppercase header
- clear separators
- first column stronger
- numeric columns right aligned
- actions right aligned
- status badge compact
- no oversized table container when there are few rows
- horizontal scroll only inside the table
- no clipped columns
- natural content height

---

# 15. Reduce excessive borders

Current pages use too many full rectangular borders.

Use this hierarchy:

Primary page divider:
- strongest neutral line

Major section border:
- subtle

Internal row divider:
- lighter

Do not place full borders around:

- every metric
- every note
- every field group
- every action group
- every empty state
- every status block

Use dividers and spacing instead.

---

# 16. Eliminate unnecessary empty space

This is critical.

Do not use:

- fixed panel heights
- large `min-h` values
- large empty lower regions
- full-width panels for tiny content
- forced equal heights when one side is empty
- oversized padding around one-row tables

Use content-driven height.

Only use scroll containers when the content can genuinely exceed the viewport.

---

# 17. Responsive behavior

Test all five pages at:

- 1440px
- 1280px
- 1024px
- 768px
- 390px

Desktop:

- actions aligned right
- summary rails fit cleanly
- detail and secondary panels balanced
- no empty black voids

Tablet:

- two-column workspaces stack
- filters remain usable
- tables scroll internally
- forms become full width

Mobile:

- one column
- header actions wrap below title
- summary rail scrolls or wraps
- tabs scroll horizontally
- selected profile/account sections remain readable
- buttons stack when necessary
- no horizontal page overflow

---

# 18. Motion

Reduce motion.

Allowed:

- subtle opacity
- 4–6px vertical entry
- 160–220ms transitions

Remove:

- card lift
- scale-on-hover
- spring animations
- staggered animation across dense admin surfaces
- animated table rows

---

# 19. Implementation process

Before editing:

1. Open the route/page files for all five screenshots.
2. Trace the shared components they use.
3. Inspect:
   - WorkspacePage
   - Panel
   - StatusPill
   - DataTable
   - EmptyState
   - FilterChipRow
   - PrimaryButton
   - GhostButton
   - FormFields
4. Inspect global CSS definitions:
   - card-surface
   - section-surface
   - inner-surface
   - btn-dark
   - btn-active
   - status-pill
5. Fix shared owners first when the correction is genuinely shared.
6. Use page-specific composition changes for page-specific layout problems.
7. Avoid large numbers of `!important` overrides.
8. Preserve existing component contracts where possible.

---

# 20. Functional preservation checklist

For every page, preserve:

- all API calls
- all queries
- all mutations
- all filters
- all status changes
- all role changes
- all assignment behavior
- all account actions
- all broker provider actions
- all server actions
- all CRM actions
- all selected-record state
- all search behavior
- all imports
- all current buttons
- all current fields
- all current labels
- all current routes
- all status and role logic
- all empty states
- all loading and error behavior

Do not add or remove actions.

---

# 21. Required result per page

## User Management

- compact page header
- connected user summary rail
- compact filter toolbar
- selected user inspector
- definition matrix instead of metric cards
- grouped status and role actions
- properly aligned assigned-partner field
- no huge empty panel

## Trader Profiles

- connected summary rail
- compact segment toolbar
- selected trader + latest notes balance
- definition matrix
- compact empty note state
- no oversized blank area

## Account Supervision

- connected account summary rail
- compact status toolbar
- selected account inspector
- connected data matrix
- coherent action toolbar
- content-driven height
- no giant empty lower region

## Broker Catalog

- slim admin notice
- provider table + add-provider form
- selected provider + server management
- compact empty state
- consistent forms
- no nested-card overload

## CRM

- underline tabs
- connected summary rail
- selected profile + recent activity
- definition matrix
- compact activity empty state
- content-driven height
- no oversized blank lower area

---

# 22. Final QA

Before finishing, verify:

- every screenshot route still renders
- all actions still work
- all filters still work
- all tables show complete columns
- no selected value is clipped
- no page has a large empty black region caused by fixed height
- no mini-card metric grids remain
- no oversized filter wrappers remain
- no giant empty states remain
- no `rounded-2xl` or `rounded-3xl` remains in these page compositions
- no functionality changed
- no API changed
- no route changed
- no new dependency added
- desktop, tablet, and mobile layouts work

---

# 23. Required Codex output

Return:

1. Summary of the shared design corrections
2. Complete changed-file list
3. Per-page summary:
   - User Management
   - Trader Profiles
   - Account Supervision
   - Broker Catalog
   - CRM
4. Shared components changed
5. Any component intentionally left unchanged and why
6. Desktop verification
7. Tablet verification
8. Mobile verification
9. Build result
10. Type-check result
11. Lint result
12. Test result
13. Confirmation that no functionality, route, action, API, permission, or dependency changed

Do not claim completion after changing only one or two pages.

Open and inspect every affected route and component before reporting completion.
