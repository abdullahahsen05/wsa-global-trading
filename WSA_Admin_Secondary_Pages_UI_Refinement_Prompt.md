# Codex Master Prompt — Refine the Remaining WSA Global Admin Pages

You are refining the following WSA Global admin pages shown in the attached screenshots:

1. Broker Catalog
2. Risk Rules
3. Copy Trading
4. Background Jobs
5. AI Controls
6. Partner Withdrawals

These pages already use the correct dark WSA Global color system. Preserve that identity.

The problem is not the palette. The problems are:

- crowded layouts
- weak visual hierarchy
- inconsistent spacing
- too many bordered sections
- dense forms with poor grouping
- large panels with awkward empty areas
- sections that feel stacked rather than composed
- controls that compete for attention
- tables that feel visually heavy
- inconsistent content widths
- inconsistent column proportions
- sections ending at different vertical positions
- too many small labels and badges
- poor balance between primary and secondary content
- insufficient breathing room
- lack of editorial rhythm
- pages that feel like admin templates rather than a refined enterprise product

Your task is to redesign the layout, positioning, spacing, sizing, alignment, and grouping of every element while preserving all functionality and all existing content.

This is a UI-only refinement.

Do not remove anything.

Do not change any route, API, query, mutation, state, handler, button behavior, form submission, filter behavior, table data, permissions, role behavior, or conditional rendering.

Do not add new product features.

Do not change the WSA Global color scheme.

Do not use Playwright MCP or any browser automation MCP server.

Use only the repository’s existing type-check, lint, test, and build commands for validation.

---

# 1. Overall visual target

The final result should feel like:

- enterprise fintech software
- institutional trading operations software
- professional broker administration software
- risk and compliance tooling
- internal control infrastructure
- calm, structured, highly usable admin software

It must not feel like:

- a generic SaaS dashboard
- a dense Tailwind template
- a collection of stacked cards
- a box-heavy AI-generated interface
- a bento grid
- a promotional landing page
- a prototype full of form panels
- a page with every piece of content enclosed separately

Use:

- flat hierarchy
- strong alignment
- consistent page rhythm
- deliberate whitespace
- connected sections
- restrained borders
- compact status labels
- professional table density
- clear separation between primary and secondary tasks

---

# 2. Preserve the color and brand system

Keep:

- near-black background
- dark neutral panels
- warm off-white text
- muted warm gray text
- WSA yellow as the main accent
- lime for verified positive states
- red for errors, danger, failure, restriction, or loss

Do not introduce:

- purple
- blue accent systems
- decorative gradients
- glassmorphism
- glowing panels
- neon borders
- heavy shadows
- colorful card backgrounds
- excessive transparency

The current color system is correct. Refine layout, not identity.

---

# 3. Geometry and borders

Use:

- shell regions: 0px radius
- major page sections: 0–4px
- standard panels: 2–4px
- inputs and buttons: 4–6px
- badges: 3–4px
- dialogs: 6–8px

Avoid:

- rounded-xl
- rounded-2xl
- rounded-3xl
- pill-shaped navigation
- pill-shaped primary buttons
- oversized icon bubbles
- large rounded empty states

Use border hierarchy:

- page section border: subtle
- internal divider: lighter
- active state: yellow
- critical state: red
- no full border around every small element

Prefer:

- row separators
- definition lists
- vertical dividers
- table rules
- left accent rails
- section headers

---

# 4. Spacing and breathing room

Use a consistent rhythm.

Desktop:

- page horizontal padding: 24–28px
- major section gap: 24px
- panel gap: 16–20px
- section padding: 20–24px
- form row gap: 16px
- label-to-control gap: 7–9px
- toolbar gap: 8–12px
- table row height: 46–52px

Tablet:

- page padding: 20px
- stacked section gap: 18–20px

Mobile:

- page padding: 16px
- section gap: 16px

Do not compress every section together.

Do not leave massive empty black areas.

Every page should feel spacious but efficient.

---

# 5. Required page composition

Every page should follow this structure:

```text
Page header
Primary actions
Thin divider
Optional summary rail
Primary workspace
Secondary workspace
```

Page header:

- eyebrow
- page title
- description
- actions aligned right
- consistent spacing
- no enclosing panel

Primary workspace:

- the main task of the page
- widest visual region
- strongest hierarchy

Secondary workspace:

- forms, details, events, contextual controls
- smaller but useful
- not cramped
- not oversized

For 2-column layouts:

- use `items-stretch`
- both columns should begin and end together
- direct children should use `h-full`
- each panel should use `flex flex-col min-h-0`
- long content should scroll internally
- shorter content should not create fake empty cards
- visually balance the row

For long lists:

- use invisible vertical scrollbars
- preserve wheel and keyboard scrolling
- do not clip
- do not overflow the page
- do not trim text

Use a shared invisible scrollbar utility:

```css
.invisible-scrollbar {
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.invisible-scrollbar::-webkit-scrollbar {
  display: none;
}
```

Correct scroll structure:

```text
panel: flex flex-col h-full min-h-0
header: shrink-0
content: min-h-0 flex-1 overflow-y-auto invisible-scrollbar
footer/actions: shrink-0
```

---

# 6. Shared page header rules

All six pages must use the same header system.

Use:

- eyebrow: 10–11px uppercase yellow
- title: 28–32px
- description: 13–15px
- actions: compact right-aligned toolbar
- divider beneath header
- 20–24px bottom spacing

Do not use oversized vertical gaps.

Do not put actions too far from the title.

Primary actions should be yellow.

Secondary actions should be dark with a subtle border.

All buttons:

- 38–42px height
- 4–6px radius
- no scale hover
- no glow
- no pill shape

---

# 7. Shared summary rail

Where summary values exist, use one continuous rail.

Use:

- one outer border
- internal vertical dividers
- compact labels
- tabular values
- semantic colors only where useful
- no separate metric cards
- no excessive top/bottom padding

Use this for:

- Risk Rules summary
- Copy Trading engine summary
- Jobs summary
- AI usage summary
- Partner ledger summary

On smaller screens:

- allow horizontal scrolling
- use invisible scrollbar
- do not squeeze cells too narrowly

---

# 8. Broker Catalog page

Current issues:

- provider table and form feel disconnected
- selected provider section is too tall
- large empty area appears beside the add-server form
- empty server state is oversized
- the lower section feels unfinished
- column proportions are not balanced
- provider table is dense while the side form is sparse
- actions and section headings are not aligned consistently

Refine the page into two balanced enterprise workspaces.

## Top notice

Convert “Admin-configured catalog” into a slim information strip.

Use:

- yellow left rail
- small icon
- title
- one concise description line
- no large panel height
- no promotional-card appearance

## Primary row

Use:

```text
Broker providers table | Add broker provider
```

Recommended ratio:

- `minmax(0, 1.9fr) minmax(320px, 0.7fr)`

Requirements:

- both columns equal height
- provider table scrolls internally if long
- add-provider form anchors actions at bottom
- side form should not appear as an empty tall column
- use balanced padding
- table numeric columns right aligned
- status and Manage actions compact

## Selected provider row

Use:

```text
Configured servers | Add configured server
```

Requirements:

- equal-height columns
- selected provider header spans the row or sits above both columns
- provider actions right aligned
- configured server list uses rows or table
- empty server state is compact and left aligned
- add-server form uses the same form system as add-provider
- no giant empty lower-left panel
- if no servers exist, the empty state should occupy only the content area, not the full page height

Do not remove:

- provider list
- create provider form
- selected provider actions
- configured server form
- activate/deactivate behavior
- refresh action
- Manage actions

---

# 9. Risk Rules page

Current issues:

- too many vertically stacked panels
- the rules table, events, create form, and account monitoring feel disconnected
- the create-rule form is dense
- the page is visually long
- open events column is cramped
- the account monitoring table adds another large section without enough hierarchy
- summary rail is visually plain
- controls compete for attention

Refine into clear page bands.

## Header and summary

- keep Create rule action in the header
- use a continuous summary rail for:
  - Rules
  - Enabled
  - Enforced
  - Open events

## Main row

Use:

```text
Risk rules | Open risk events
```

Recommended ratio:

- `minmax(0, 1.7fr) minmax(340px, 0.8fr)`

Requirements:

- equal-height columns
- risk rules table fills main region
- event queue uses rows, not event cards
- event list scrolls invisibly when long
- action buttons stay aligned
- no cramped narrow event content
- severity should be easy to scan

## Create risk rule

Make the form calmer.

Use:

- one flat section
- 3-column field grid on wide screens
- 2 columns on tablet
- 1 column mobile
- consistent field widths
- labels aligned
- helper copy below relevant group
- Reset and Create rule actions aligned in one footer
- no large red icon block
- no oversized section title area

## Monitoring table

- retain all columns
- use a natural-height table
- no unnecessary empty panel height
- compact notice beneath the table
- keep table as the final page section
- horizontal scroll inside table only

Do not remove any rules, events, form fields, enforcement options, actions, account rows, or table columns.

---

# 10. Copy Trading page

Current issues:

- the page is extremely long
- many sections are stacked vertically
- forms use too many columns with weak grouping
- strategy and account sections are visually sparse
- repeated bordered panels create fatigue
- global and per-account rules are too wide
- recent triggers table is detached from the rest of the workflow
- large unused widths exist in some rows
- warning and summary areas compete with page content

Refine the page into a workflow-oriented control console.

## Header

Keep:

- New master account
- New strategy

Align them in one compact toolbar.

## Live warning

Use a slim alert strip.

- no oversized border box
- concise message
- clear severity
- yellow or red left rail
- no extra vertical padding

## Engine summary

Use a connected summary rail.

Include current values exactly.

Do not create separate cards.

## Master accounts and published strategies

Use one balanced 2-column row:

```text
Master accounts | Published strategies
```

Recommended ratio:

- `minmax(0, 0.9fr) minmax(0, 1.1fr)`

Requirements:

- equal-height columns
- long lists scroll internally
- master accounts displayed as list rows, not cards
- strategy rows show:
  - name
  - status
  - master
  - followers
  - error
  - price
  - publish action
- avoid large blank regions
- action alignment consistent

## Global stoppage rules

Use a structured settings section.

Group fields into:

- risk limits
- execution limits
- connection behavior
- actions

Do not place five equal fields in one long row if it reduces readability.

Preferred desktop layout:

- 3 columns first row
- 2 columns second row
- actions in footer

## Per-account rules

Use a structured 2-column or 3-column form grid.

Group:

- account selection and enabled state
- risk limits
- copy limits
- symbol rules

Anchor Save account rules in the footer.

Avoid one extremely wide row with eight fields.

## Recent rule triggers

- use full-width table
- compact rows
- reason column gets the most width
- numeric/status columns compact
- natural height unless intentionally constrained
- internal scrolling if long
- invisible scrollbar
- preserve all data

Do not remove any account, strategy, checkbox, input, select, action, trigger, or status.

---

# 11. Background Jobs page

Current issues:

- page is long and table-heavy
- the filter section is boxed unnecessarily
- summary, notice, filters, and table appear as separate stacked blocks
- action toolbar is wide
- repeated View buttons create visual noise
- job table uses too much vertical space
- pending and success rows are not easy to scan
- the page feels operationally dense rather than refined

Refine into a compact job operations console.

## Header

Keep:

- Queue sync all
- Queue monitor all
- Run worker now

Use:

- one compact action toolbar
- clear primary action
- consistent button sizing

## Summary rail

Use one continuous rail for:

- Pending
- Running
- Success today
- Failed today
- Skipped today

## Result notice

Use a slim status strip directly beneath the rail.

No oversized box.

## Filters

Use a compact horizontal toolbar.

- All
- Pending
- Running
- Success
- Failed
- Skipped
- Cancelled

Do not place filters inside a large padded panel.

## Jobs table

Use:

- sticky header if table has constrained height
- internal vertical scrolling
- invisible scrollbar
- compact row height
- clear status hierarchy
- attempts and timestamps aligned
- Last error gets appropriate width
- actions right aligned
- View, Cancel, Retry preserved
- do not create separate boxes for each action

Consider constraining the table region to viewport height:

```text
max-height: calc(100vh - shell/header/summary/toolbars)
overflow-y-auto
invisible-scrollbar
```

Do not let the page become excessively long if the job list is large.

Do not clip rows.

Do not remove any job action or status.

---

# 12. AI Controls page

Current issues:

- provider configuration, assistant, image analysis, usage metrics, user limits, selected user, credits, and activity are all visually competing
- page is very long
- sections are stacked without enough hierarchy
- provider cards are card-heavy
- assistant and image analysis panels are oversized
- user table and selected-user management are not balanced
- recent activity is cramped
- token credit controls feel detached
- there is too much vertical scrolling

Refine into clear operational bands.

## Provider security

Use:

- one section header
- provider rows inside one connected frame
- Gemini and OpenAI as rows or balanced columns
- actions aligned consistently
- provider status right aligned
- metadata on one line or compact grid
- no card inside card

## Assistant and image analysis

Use one balanced 2-column row.

Requirements:

- equal height
- text area or input region fills available height
- actions anchored at bottom
- helper text concise
- image upload and focus area grouped
- no oversized blank content areas
- internal scroll only if results can grow
- invisible scrollbar

## Usage summary

Use a connected summary rail for:

- Requests today
- Chat
- Chart analyses
- Failed

## Trader AI limits workspace

Use:

```text
User limits table | Manage selected user
```

Recommended ratio:

- `minmax(0, 1.5fr) minmax(340px, 0.8fr)`

Requirements:

- equal-height columns
- table scrolls internally if long
- selected-user controls grouped:
  - access
  - chat limit
  - chart limit
  - credits
  - actions
- token credit form aligned
- recent activity integrated below or inside the right column as a scrollable subsection
- no tiny crowded activity panel
- no giant unused left table height

Do not remove any provider action, assistant action, image action, user row, limit field, credit control, activity item, or permission behavior.

---

# 13. Partner Withdrawals page

Current issues:

- the top request/review area is mostly empty
- two large panels occupy large height with no content
- empty state is oversized
- the partner ledger section is very long
- the table and rebate form are unbalanced
- large empty black regions dominate the page
- filters feel disconnected from the main task
- selected partner and ledger totals are not grouped strongly

Refine into a content-driven financial operations page.

## Header

Keep current title and description.

## Status filters

Use a compact toolbar:

- All
- Pending Review
- Approved
- Paid
- Rejected

Do not wrap it in an oversized panel.

## Withdrawal requests workspace

Use:

```text
Request list | Review request
```

Recommended ratio:

- `minmax(0, 1.4fr) minmax(340px, 0.8fr)`

Requirements:

- content-driven height
- when no requests exist:
  - show a compact empty state
  - do not force both columns to be tall
  - review panel should collapse or remain compact if there is nothing selected
- when requests exist:
  - both columns equal height
  - list scrolls internally
  - review details scroll internally if long
  - no large blank region

## Ledger section

Use:

- selected partner context header
- partner selector aligned right
- partner identity row
- connected financial summary rail:
  - Withdrawable
  - Approved commissions
  - Approved rebates
  - Locked

Then use:

```text
Ledger table | Add rebate entry
```

Requirements:

- balanced widths
- equal-height columns
- ledger table scrolls internally if long
- form actions anchored at bottom
- no oversized empty lower-left area
- no giant section panel around everything
- use dividers and hierarchy

Do not remove filters, request list, review panel, partner selector, financial totals, ledger rows, or rebate form fields.

---

# 14. Shared table refinements

All tables across these pages must use one system.

Use:

- 46–50px rows
- compact uppercase headers
- clear row separators
- first column stronger
- numeric columns right aligned
- status badges compact
- actions right aligned
- subtle row hover
- no row cards
- no rounded header cells
- no entry animation
- no large empty area below short tables
- internal horizontal scroll
- invisible scrollbar
- internal vertical scroll when constrained
- sticky header where useful

Do not clip any columns.

Do not let tables force page-wide horizontal overflow.

---

# 15. Shared form refinements

All forms must use one system.

Use:

- 46–50px controls
- 4–6px radius
- consistent labels
- consistent vertical spacing
- dark neutral surface
- subtle border
- yellow focus state
- no shadow
- no oversized fields
- no awkward narrow side forms

Group related fields.

Use:

- section labels
- field grids
- helper copy
- footer actions

Do not place too many unrelated fields in one row.

Do not leave actions floating midway through a form.

---

# 16. Empty states

All empty states must be compact.

Use:

- small icon or no icon
- title
- one-line description
- optional existing action
- natural height
- left aligned in operational panels
- no giant box
- no large minimum height
- no decorative padding

Examples:

- No configured servers
- No requests
- No activity
- No jobs
- No matching records

Do not leave a blank secondary column.

---

# 17. Equal-height and overflow rules

For every 2-column or 3-column row:

- use `items-stretch`
- direct children `h-full`
- section root `flex flex-col min-h-0`
- section header `shrink-0`
- scrollable content `min-h-0 flex-1 overflow-y-auto invisible-scrollbar`
- section footer `shrink-0`
- columns should visually end at the same place
- do not clip content
- do not let long content force the entire page to grow if the row is intended as a fixed operational band
- do not let short content create massive fake empty areas

If content is short:

- use natural height
- do not force an artificial minimum height

If content is long:

- constrain the intended region
- enable invisible internal scroll
- preserve all content

---

# 18. Responsive behavior

Review each page at:

- 1440px
- 1280px
- 1024px
- 768px
- 390px
- 320px

Desktop:

- balanced columns
- no leftover black space
- equal row endings
- compact toolbars
- full-width useful content

Tablet:

- secondary panels stack below primary
- forms move to 2 or 1 columns
- tables scroll internally
- toolbars wrap or scroll

Mobile:

- one column
- no page horizontal overflow
- tabs and filters horizontally scroll
- invisible scrollbar
- buttons stack only where needed
- tables scroll internally
- forms full width
- no clipped text or controls

---

# 19. Shared components to inspect

Before page-specific edits, inspect:

- WorkspacePage
- Panel
- DataTable
- StatusPill
- FilterChipRow
- InlineStatusStrip
- PrimaryButton
- GhostButton
- EmptyState
- FormFields
- AppShell
- Sidebar
- Topbar
- global CSS utilities
- invisible scrollbar utility

Fix shared owners where appropriate.

Do not globally break unrelated pages.

Use a compact or dense variant only when justified.

---

# 20. Functional preservation checklist

For all six pages, preserve:

- every API call
- every query
- every mutation
- every button
- every input
- every select
- every checkbox
- every filter
- every table
- every row
- every status
- every action
- every permission
- every conditional state
- every loading state
- every error state
- every empty state
- every route
- every role behavior

No functionality changes.

No dependency changes.

No Playwright MCP.

---

# 21. Required implementation sequence

1. Open all six route files.
2. Trace every rendered component.
3. Inspect shared styles and primitives.
4. Fix shared spacing, panel, table, form, badge, and scrollbar owners.
5. Refine Broker Catalog.
6. Refine Risk Rules.
7. Refine Copy Trading.
8. Refine Background Jobs.
9. Refine AI Controls.
10. Refine Partner Withdrawals.
11. Review responsive behavior.
12. Run type-check.
13. Run lint.
14. Run unit tests.
15. Run build.
16. Report manual screenshot-review routes.

Do not stop after two or three pages.

---

# 22. Required Codex output

Return:

1. Summary of the new shared layout system
2. Complete changed-file list
3. Shared components changed
4. Page-by-page summary:
   - Broker Catalog
   - Risk Rules
   - Copy Trading
   - Background Jobs
   - AI Controls
   - Partner Withdrawals
5. Equal-height column implementation notes
6. Invisible scrollbar implementation notes
7. Desktop review notes
8. Tablet review notes
9. Mobile review notes
10. Type-check result
11. Lint result
12. Test result
13. Build result
14. Confirmation that no functionality changed
15. Confirmation that no route, API, permission, action, field, or dependency changed
16. Confirmation that Playwright MCP was not used
17. Remaining manual screenshot-review risks

The final result should preserve all content while making every page feel calmer, more spacious, more deliberate, more professional, and more like one enterprise trading operations platform.
