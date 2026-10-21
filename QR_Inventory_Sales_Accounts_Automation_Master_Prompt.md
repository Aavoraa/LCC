# Master Development Prompt: QR-Enabled Inventory, Sales & Accounts Automation Platform

## 1. Role and Objective

Act as a senior software architect, ERP consultant, full-stack developer, AI integration engineer, and premium UI/UX designer.

Design and develop a production-ready, modular ERP platform that digitizes the existing company workflow shown in the attached **QR-Enabled Inventory & Sales Delivery Automation Flow**.

The system must replace manual stock cards, handwritten stock updates, duplicate data entry, manual stock verification, and disconnected accounting processes with a centralized database, QR-enabled Android inventory operations, intelligent invoice extraction, and real-time sales delivery estimation.

Do not build only a dashboard prototype. Implement working modules, database schemas, API endpoints, validation, role-based access control, audit logs, and integrations.

First inspect the existing project repository and identify its current framework, database, authentication system, reusable components, and completed features. Preserve existing functionality and extend the project rather than unnecessarily rebuilding it.

## 2. Technology Architecture

Use the following preferred stack where compatible with the existing repository:

- Frontend: Next.js, React, TypeScript.
- UI: Tailwind CSS, shadcn/ui, Lucide icons, accessible component patterns.
- Backend: FastAPI with Python, or retain the existing backend if it is already suitable.
- Database: PostgreSQL.
- ORM and migrations: SQLAlchemy and Alembic for a FastAPI backend.
- Android: React Native with Expo or a suitable native Android implementation.
- QR scanning: Camera-based QR/barcode scanning with a manual lookup fallback.
- QR generation: Server-generated QR codes with downloadable PNG, SVG, and printable label formats.
- Invoice intelligence: Claude Vision through the official Anthropic API, with an interchangeable document-extraction provider interface.
- File storage: Private object storage or an equivalent secure document store.
- API: Authenticated REST APIs with validation and transaction management.
- Deployment: Environment-based configuration, HTTPS, secure secrets, automated backups, logging, and health checks.

Adapt these choices to the current project rather than introducing unnecessary technologies.

## 3. Main Application Navigation

Create a modern ERP sidebar with the following modules:

1. Executive Dashboard
2. Sales & Customer Enquiries
3. Inventory & Stores
4. QR Code Management
5. Raw Materials
6. Purchased Items
7. Daily Consumables
8. Processed Spares
9. Procurement & Suppliers
10. Production & Planning
11. Quality Control
12. Accounts & Finance
13. Invoice Scanner & AI Extraction
14. Reports & Analytics
15. Users, Roles & Settings
16. Audit Trail

Provide a responsive web interface and an Android-first inventory experience.

## 4. QR Code Management

### A. Create a new inventory item

Build an Add New Item workflow with:

- Auto-generated, unique item code.
- Item name and description.
- Category and subcategory.
- Item type: Raw Material, Purchased Item, Daily Consumable, Processed Spare, Finished Good, or Service.
- Unit of measurement.
- Manufacturer and supplier.
- Make/model and technical specifications.
- Minimum stock, reorder level, and maximum stock.
- Default storage location, rack, and bin.
- Batch or serial tracking, where applicable.
- Opening balance and stock valuation method.
- GST/HSN information where applicable.
- Optional item image and supporting documents.

On saving a valid item, automatically generate its QR code and provide:

- Download QR as PNG or SVG.
- Printable labels with item code, item name, and QR.
- A preview before printing.
- Bulk label printing for multiple items.
- QR regeneration when necessary without changing the permanent item identity.

Never create a duplicate item code. Validate duplicate items using configurable matching rules and allow an authorized user to review possible duplicates.

### B. Existing inventory migration

The company already maintains inventory records and stock information.

Build an Existing Item Import and Migration module that supports:

- Import from CSV and Excel.
- Mapping spreadsheet columns to system fields.
- Previewing records before import.
- Validating required fields and units.
- Duplicate item detection.
- Reporting rejected rows and correction reasons.
- Importing opening stock only after reconciliation and approval.
- Recording the import batch, responsible user, date, and approval status.

Existing item selection must also be available directly from the database.

### C. Generate QR codes for existing items

Allow the user to:

1. Search or filter existing inventory.
2. Select one item or multiple items.
3. Generate QR labels for selected items.
4. Print labels and attach them to existing bins, packages, or tracked units.
5. Verify a label by scanning it.
6. Map the scanned QR to the existing item record rather than creating a new item.

The QR code should contain a secure, stable item identifier or an opaque inventory URL, not sensitive supplier, cost, or account data.

Support SKU-level QR codes and, where necessary, separate batch-level or serial-level identifiers.

## 5. Android Inventory Management

Build a practical Android application for storekeepers and authorized staff.

### Main screens

- Home dashboard.
- Scan QR.
- Receive stock.
- Issue stock.
- Transfer stock.
- Return stock.
- Physical stock count.
- Stock adjustment request.
- Search inventory.
- Transaction history.
- Pending synchronization.
- Notifications.

### QR transaction workflow

1. Open the scanner.
2. Scan the item or bin QR code.
3. Fetch the matching item and location.
4. Display the current physical balance, reserved quantity, and available quantity.
5. Select a transaction type.
6. Enter quantity, source/destination location, and related document.
7. Validate permissions, quantity, stock availability, and business rules.
8. Show a confirmation summary.
9. Submit the transaction.
10. Record the movement in the central inventory ledger.
11. Refresh the item balance and relevant dashboards.

Support transactions against Sales Orders, Purchase Orders, PAD/WIP documents, assembly requests, and authorized internal requisitions.

Do not modify inventory balances through direct manual edits. Use validated stock movement transactions. Corrections must create traceable adjustment entries with a reason and the required approval.

Support offline capture only with unique transaction identifiers, duplicate prevention, explicit synchronization status, and conflict handling. Never show a pending offline transaction as confirmed server stock.

## 6. Inventory and Stores Management

Preserve the existing three main inventory streams.

### A. Brought Out Materials

#### Daily Consumables

- Departmental requisition.
- Stock availability.
- Purchase or purchase request.
- Procurement approval.
- Delivery to the requesting department.
- Consumption and movement history.

#### Purchased Items

- Sales Order/PAD item verification.
- Availability check.
- Purchase initiation.
- Purchase approval.
- Purchase Order creation.
- Goods receipt.
- Quality inspection.
- Stock ledger update.
- Issue to assembly.

### B. Raw Materials

- Stock availability.
- QR-based receipt and issue.
- Warehouse, rack, and bin tracking.
- Reservation and allocation.
- In-house and outside-process issue.
- Reorder monitoring.
- Material traceability.

### C. Processed Materials / Spares

Preserve the existing three processing scenarios:

1. All processes in-house or all processes outsourced.
2. The final two processes outsourced.
3. Type 1: Process 2 outsourced; Type 2: any one process in-house.

Configure each item or PAD with its actual process route, operation sequence, standard duration, QC requirements, and vendor lead time.

Track:

- Process 1 through Process 4, where applicable.
- Quality inspection between operations.
- Outsourced material dispatch and return.
- Process completion.
- Final QC.
- Store receipt.
- Delivery to assembly.

Do not hardcode the three scenarios as the only possible routes. Provide a configurable process-routing master.

## 7. Pre-Sales Availability and Delivery Estimation

This is a high-priority business feature.

Before confirming an order, authorized salespeople must be able to estimate availability without calling the Stores department.

Create an enquiry form with:

- Customer.
- Enquiry reference.
- Machine or spare.
- Item code.
- Requested quantity.
- Required delivery date.
- Customer location.
- Optional notes and attachments.

### Availability calculation

Display:

- Physical stock.
- Reserved stock.
- Quality-hold stock.
- Available-to-promise quantity.
- Incoming purchase quantities.
- Expected receipt dates.
- Other committed demand.
- Material shortage quantity.

Calculate available-to-promise quantities using a consistent inventory policy. Do not count quality-hold material, already-reserved stock, or unconfirmed incoming stock as immediately available.

### Delivery estimation engine

If sufficient stock exists, estimate delivery based on QC, packing, dispatch, and transport.

If stock is insufficient, evaluate:

- BOM/material requirements.
- Purchase lead times.
- Supplier availability.
- Procurement approval time.
- In-house work-centre capacity.
- Outside-process vendor capacity and lead time.
- Process sequencing.
- QC and possible rework allowance.
- Assembly and dispatch.
- Working calendars, holidays, and existing production commitments.

Display a preliminary delivery date, confidence or risk indicator, assumptions, and the critical dependencies.

Sales must be able to create a quotation with the estimated delivery date.

The estimate must be calculated from configurable rules and actual data, not invented by an AI model.

## 8. Confirmed Sales Order and Delivery Scheduling

Once the order is confirmed:

1. Convert the accepted quotation or enquiry into a Sales Order.
2. Validate stock and demand again.
3. Reserve available material atomically to prevent double allocation.
4. Create shortages and procurement requisitions.
5. Create or link the appropriate PAD/WIP.
6. Generate the process schedule.
7. Reserve production capacity where supported.
8. Track external processing and expected returns.
9. Schedule QC and assembly.
10. Calculate a committed delivery date.
11. Display milestones and responsible departments.
12. Recalculate the forecast when material receipts, operations, or inspections are delayed.

Keep preliminary estimates separate from approved delivery commitments. Require authorized approval before a committed date is communicated when company policy demands it.

## 9. Accounts and Finance Module

Create a full accounts module connected to procurement, sales, inventory, and invoice extraction.

### A. Chart of Accounts

- Assets.
- Liabilities.
- Equity.
- Revenue.
- Expenses.
- Cost of Goods Sold.
- Inventory and stock-in-transit accounts.
- Accounts Receivable.
- Accounts Payable.
- GST input/output and tax control accounts, as applicable.

Support configurable account codes, account groups, and opening balances.

### B. Sales Accounts

- Customer master.
- Quotations and sales orders.
- Sales invoices.
- Credit notes and debit notes.
- Customer receipts.
- Outstanding invoices.
- Receivables ageing.
- Customer ledger.
- Sales register.
- Tax summaries.

### C. Purchase Accounts

- Supplier master.
- Purchase Orders.
- Goods receipts.
- Supplier invoices.
- Debit notes and purchase returns.
- Supplier payments.
- Outstanding bills.
- Payables ageing.
- Supplier ledger.
- Purchase register.

### D. General Ledger

- Journal entries.
- Cash and bank accounts.
- Payment and receipt vouchers.
- Expense recording.
- Bank reconciliation.
- Trial balance.
- Profit and loss statement.
- Balance sheet.
- Cash flow reports.

### E. Inventory Accounting

Connect inventory movements to the appropriate accounting events.

Support configurable inventory valuation, such as weighted average or FIFO, according to the company's accounting policy. Maintain quantity and valuation records with appropriate reconciliation.

Goods receipt, supplier invoice, payment, material issue, finished goods, and sales dispatch must not create duplicate accounting entries. Use controlled posting rules, unique source-document references, and approval workflows.

### F. Financial Controls

- Sequential document numbers.
- Financial-period locking.
- Role-based approvals.
- Immutable posted-entry history.
- Reversal entries instead of silent edits.
- Duplicate invoice checks.
- Tax and rounding validation.
- Exportable financial reports.
- Configurable GST and Indian accounting requirements.

Treat this as an accounting subledger and ERP finance module; do not claim statutory compliance without validation by the company's accountant or tax professional.

## 10. Claude Vision Invoice Scanner

Integrate Claude Vision through the official Anthropic API, with a provider abstraction so another OCR or document-extraction engine can be added later.

### Supported documents

- Supplier tax invoices.
- Purchase invoices.
- Sales invoices.
- Delivery challans.
- Credit notes.
- Debit notes.
- Purchase Orders.
- Goods receipt documents.
- Expense bills.

Support PDF, JPG, JPEG, and PNG, including multi-page documents where supported.

### Invoice scanning workflow

1. Upload or scan a document using the web interface or Android camera.
2. Store the original document securely.
3. Classify the document type.
4. Send the document to the configured vision-extraction provider through the backend.
5. Extract candidate fields into structured JSON.
6. Validate and normalize the results.
7. Display the original document next to the extracted fields.
8. Allow the user to review, correct, and confirm.
9. Map the confirmed data into the correct purchase invoice, sales invoice, expense, or other document form.
10. Save a link to the original document and the extraction audit record.
11. Post to the accounts module only after the required approval.

### Fields to extract

**Document details**
- Document type.
- Invoice number.
- Invoice date.
- Due date.
- Purchase Order reference.
- Goods receipt reference.
- Currency.

**Supplier/customer**
- Name.
- Address.
- GSTIN, where applicable.
- Contact details where present.

**Line items**
- Item description.
- Existing item code, if identifiable.
- HSN/SAC, if present.
- Quantity.
- Unit.
- Unit price.
- Discount.
- Taxable value.
- Tax rate and tax amount.
- Line total.

**Totals**
- Subtotal.
- Freight and other charges.
- CGST, SGST, IGST, or other applicable tax.
- Round-off.
- Invoice total.
- Amount paid.
- Balance due.

### Intelligent field mapping

Match extracted invoice items to existing inventory items using item codes, descriptions, units, supplier item references, and configurable matching rules.

If the invoice contains an unknown item, suggest a possible match or create a draft item proposal. Never silently create a duplicate item or change the master item record.

For each extracted field, retain the value, confidence where provided or reasonably derived, source-page reference, and review status.

Highlight uncertain fields and allow users to correct them before submission.

### Validation and security

- Validate arithmetic totals and tax calculations.
- Compare supplier invoices against Purchase Orders and goods receipts where available.
- Detect duplicate invoices using supplier identity, invoice number, date, amount, and configurable matching rules.
- Treat extracted document text as untrusted input, not executable instructions.
- Protect API keys on the server.
- Do not send confidential documents to an external model without authorized configuration and appropriate data-handling controls.
- Log the extraction provider, request reference, reviewer, corrections, and approval outcome.

Claude Vision should extract and organize invoice data; the application must remain responsible for validation, account mapping, approvals, and posting.

## 11. Modern Premium UI/UX Design

Create a premium industrial ERP experience comparable to modern enterprise SaaS platforms.

### Design direction

- Clean, high-density but uncluttered interface.
- Deep navy and cobalt blue as primary colors.
- Teal or green for successful transactions.
- Amber for pending actions.
- Red for exceptions and critical shortages.
- Neutral gray backgrounds.
- Subtle shadows, fine borders, restrained gradients, and consistent spacing.
- Professional typography, strong information hierarchy, and consistent iconography.
- Responsive layouts for desktop, tablet, and mobile.
- Dark and light themes.
- Accessible color contrast, keyboard navigation, and visible focus states.

Avoid excessive gradients, oversized cards, unnecessary animations, and decorative UI that reduces operational clarity.

### Global application shell

Create:

- Collapsible left sidebar.
- Global search and command palette.
- Context-aware top bar.
- Notifications and task inbox.
- User profile and role indicator.
- Breadcrumbs.
- Quick-create menu.
- Recent records.
- Persistent help and keyboard shortcuts.

### Executive dashboard

Display:

- Total inventory valuation.
- Total stock items.
- Low-stock and out-of-stock items.
- Available versus reserved stock.
- Pending purchase orders.
- Goods receipts pending QC.
- Work in progress.
- Outside-processing materials outstanding.
- Sales orders awaiting material.
- Orders at risk of late delivery.
- Accounts receivable and payable.
- Cash and bank summary.
- Invoice extraction pending review.

Provide charts and drill-down tables. All figures must come from real API/database queries; do not use hardcoded sample metrics in production.

### Inventory screens

Build a searchable, filterable inventory table with item code, QR status, category, location, physical quantity, reserved quantity, available quantity, reorder level, and valuation.

Include:

- Compact and comfortable density options.
- Column visibility controls.
- Saved filters.
- Bulk selection and label printing.
- Side-panel item details.
- Stock movement timeline.
- Clear empty, loading, error, and permission-denied states.

### Accounts screens

Use structured tables, clear financial totals, document status badges, side-by-side invoice review, account ledgers, and drill-down financial statements.

### Invoice scanner screen

Create a split-screen review workspace:

- Left panel: document viewer and page navigation.
- Right panel: extracted invoice fields.
- Highlighted uncertain fields.
- Supplier and item matching suggestions.
- Tax and total validation.
- Save Draft, Request Review, Approve, and Post actions according to permissions.

Do not automatically post unverified extracted values.

## 12. Roles and Permissions

Implement configurable role-based access control for:

- Super Admin.
- Management.
- Sales.
- Stores.
- Purchase.
- Planning & Design.
- Production.
- QC.
- Accounts.
- Finance Approver.
- Auditor.

Enforce permissions on the backend, not just in the interface.

Examples:

- Sales can view availability and prepare quotations.
- Stores can record authorized stock movements.
- Purchase can manage requisitions, purchase orders, and receipts within its permissions.
- QC can record inspections and place or release quality holds.
- Accounts can prepare financial documents.
- Authorized approvers can approve and post transactions.
- Auditors can inspect history without modifying transactions.

Support maker-checker approval for stock adjustments, purchase approvals, invoice posting, and other sensitive operations.

## 13. Database Design

Create normalized relational tables and appropriate indexes for:

- Users, roles, permissions.
- Customers and suppliers.
- Item categories and item master.
- Units of measurement.
- Warehouses, locations, racks, and bins.
- QR identifiers and item/batch/serial mappings.
- Stock ledger and stock balance projections.
- Stock transfers and stock counts.
- Reservations and allocations.
- Sales enquiries, quotations, and sales orders.
- BOMs and PAD/WIP.
- Process routes, operations, and work centres.
- Procurement requisitions and Purchase Orders.
- Goods receipts and QC inspections.
- Outside-processing transactions.
- Deliveries and dispatch.
- Chart of Accounts and journal entries.
- Sales invoices, purchase invoices, receipts, and payments.
- Invoice files, extracted fields, review history, and provider references.
- Approval workflows.
- Audit events and notification records.

Use foreign keys, unique constraints, transaction-safe stock updates, appropriate decimal precision, and migration scripts.

Maintain an append-only stock movement history and a controlled accounting journal. Derived balances must be reconcilable to their underlying transactions.

## 14. API and Business Logic

Implement validated endpoints for:

- Item CRUD and duplicate checks.
- Bulk import and reconciliation.
- QR generation and lookup.
- Stock receipt, issue, transfer, return, and adjustment.
- Inventory availability and reservation.
- Sales enquiry and quotation.
- Delivery estimation and scheduling.
- Purchase requisitions and Purchase Orders.
- Goods receipt and QC.
- Invoice upload, extraction, review, and posting.
- Accounts journals and financial reports.
- Users, roles, approvals, and audit logs.

Use database transactions and concurrency controls for stock reservation and issue. Use idempotency keys for operations that could otherwise create duplicate movements or financial entries.

Provide API documentation, clear error messages, structured logs, and automated tests.

## 15. Reporting and Alerts

Implement:

- Stock ledger.
- Physical versus system stock reconciliation.
- Low-stock report.
- Slow-moving and non-moving inventory.
- Stock valuation.
- Purchase pending report.
- Outside-processing outstanding report.
- QC pending report.
- Order-wise material availability.
- Delivery adherence and delay analysis.
- Sales and purchase registers.
- Customer receivables ageing.
- Supplier payables ageing.
- General ledger and trial balance.
- Invoice extraction accuracy and review backlog.

Create configurable notifications for reorder levels, stock discrepancies, delayed procurement, outside-processing delays, QC failures, overdue invoices, and threatened delivery dates.

## 16. Testing and Acceptance Criteria

The implementation is accepted only when the following scenarios work end to end:

1. Create a new item and generate a printable QR label.
2. Import an existing inventory spreadsheet and resolve duplicate records.
3. Generate QR labels for selected existing items without creating duplicates.
4. Scan an item on Android and record a receipt that updates server stock.
5. Issue stock against an authorized request and verify the resulting balance.
6. Prevent unauthorized or excessive stock issue.
7. Show live free stock to Sales before order confirmation.
8. Calculate a preliminary delivery estimate for sufficient stock and for a shortage.
9. Confirm a Sales Order, reserve material, and create the appropriate procurement and production actions.
10. Update delivery forecasts when a supplier or process is delayed.
11. Scan or upload a supplier invoice and extract structured fields using Claude Vision.
12. Review and correct invoice data, validate totals, detect duplicates, and post only after approval.
13. Verify that stock and accounting transactions have traceable histories.
14. Verify role permissions, concurrent stock transactions, and duplicate-submission protection.
15. Reconcile stock ledger totals and accounting reports against their source transactions.
16. Confirm responsive layouts and error handling across supported devices.

## 17. Development Execution Plan

Work in the following sequence:

**Phase 1:** Inspect the repository, document the current architecture, identify reusable features, and propose implementation changes.

**Phase 2:** Establish database migrations, authentication, role permissions, design system, and global application shell.

**Phase 3:** Implement item master, QR generation, existing-item migration, inventory ledger, and Android scanning.

**Phase 4:** Implement procurement, raw materials, purchased items, consumables, processed spares, QC, and production workflows.

**Phase 5:** Implement pre-sales availability, quotations, reservations, delivery estimation, and confirmed order scheduling.

**Phase 6:** Implement accounts, financial controls, invoice upload, Claude Vision extraction, and review workflows.

**Phase 7:** Implement reports, notifications, security hardening, testing, deployment documentation, and backup procedures.

For each phase, deliver working code, database migrations, API contracts, automated tests, and concise documentation. Maintain a clear distinction between implemented functionality, mock data, and future integrations.

Start by inspecting the existing project repository and the supplied flowchart. Then produce the implementation plan and begin building the first functional vertical slice: item master → QR generation → Android scan → stock transaction → live dashboard update.

Do not stop at generating a plan, wireframe, or static UI. Implement the system incrementally, test each workflow, and report any incomplete integrations honestly.
