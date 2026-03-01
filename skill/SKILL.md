---
name: Invoice Manager
description: "Manage company invoices (发票管理). Process uploaded invoice images/PDFs via vision, extract fields, store in SQLite, query and generate tax reports. Supports Chinese fapiao types: rail tickets, general VAT invoices, ride-hailing e-invoices, taxi receipts, VAT special invoices. Handles inbound (进项) and outbound (销项) directions, reimbursement tracking, and monthly packaging for external accountants."
---

# Invoice Manager (发票管理)

## Quick Start

CLI path: `invoice-manager.mjs` in this skill folder.
```bash
node /path/to/skill/invoice-manager.mjs <command>
```

Initialize database on first use:
```bash
node invoice-manager.mjs init
```

## Processing an Uploaded Invoice

When the user uploads an invoice (image or PDF):

### Step 1: Identify the invoice type

- `rail_ticket` — 高铁票/火车票: route, seat, fare, passenger
- `general_invoice` — 增值税普通发票: tax breakdown, buyer/seller info
- `ride_hailing` — 网约车发票 (高德/滴滴): trip details, platform
- `taxi_receipt` — 出租车票: paper receipt with 发票代码, fare, distance
- `vat_special` — 增值税专用发票: special deduction rights
- `other` — anything else

### Step 2: Determine direction

- `inbound` (进项): FROM other companies TO us — expenses we paid
- `outbound` (销项): FROM us TO others — revenue we earned

Rules:
- Buyer matches our company -> inbound
- Seller matches our company -> outbound
- Transportation invoices -> almost always inbound
- If unclear, ask: "这张发票是进项还是销项？"

### Step 3: Extract fields via vision

Read ALL visible fields. Required per type:

**taxi_receipt:** invoice_code, invoice_number, amount, invoice_date, vendor_name; extra: distance, unit_price, car_number

**rail_ticket:** amount, invoice_date; extra: departure, arrival, seat_class, seat_number, passenger, train_number

**ride_hailing:** invoice_number, invoice_code, amount, tax_amount, invoice_date, vendor_name; extra: trip_count, platform

**general_invoice / vat_special:** invoice_number, invoice_code, amount, tax_amount, tax_rate, invoice_date, vendor_name, vendor_tax_id, buyer_name, buyer_tax_id; extra: items

### Step 4: Save file and store

**CRITICAL**: When the user sends an invoice image/PDF, you MUST use `add-invoice.sh` instead of calling `invoice-manager.mjs add` directly. The wrapper script automatically attaches the most recently uploaded file.

```bash
bash /app/skills/invoice-manager/add-invoice.sh --json '{
  "invoice_type": "taxi_receipt",
  "direction": "inbound",
  "amount": 15.00,
  ...
}'
```

**Always use `bash /app/skills/invoice-manager/add-invoice.sh`** for adding invoices when a file was uploaded. This ensures the original file is always saved.

Only use `node invoice-manager.mjs add` directly for manual entries with no file attachment.

### Step 5: Assign category

Auto-categorize: `transportation` (rail, taxi, ride-hailing), `dining`, `office`, `equipment`, `service`, `accommodation`, `communication`, `other`

### Step 6: Confirm to user

```
✅ 发票已录入
类型: 出租车票 | 方向: 进项 | 金额: ¥15.00
开票方: 深圳市龙深运输有限公司
日期: 2026-01-30 | 发票号码: 02378667
分类: 交通出行 | 报销状态: 未报销
```

## Reimbursement Management

Invoices have a separate reimbursement status:
- `unreimbursed` — 未报销 (default)
- `submitted` — 已提交报销
- `reimbursed` — 已报销
- `rejected` — 报销被驳回

When user says:
- "这张发票已报销" -> `reimburse <id>`
- "标记为已提交报销" -> `update <id> --json '{"reimbursement_status":"submitted"}'`
- "还有哪些没报销的" -> `unreimbursed`
- "本月未报销金额" -> `stats --month YYYY-MM --reimbursement unreimbursed`

## Monthly Packaging

**Rule: On the last day of each month, proactively ask the user if they want to package this month's invoices.**

When user says "打包本月发票" or it's month-end:
```bash
node invoice-manager.mjs package --month 2026-01
```

This creates a zip at `exports/YYYY-MM-发票汇总.zip` containing:
- `summary.csv` — invoice list with all fields
- `invoices/` — all original files, renamed by sequence

Send the zip file to the user via Telegram so they can forward it to their accountant.

## Query Patterns

- "本月发票" -> `list --month 2026-01`
- "本月交通费" -> `list --month 2026-01 --category transportation`
- "Q1进项汇总" -> `stats --quarter 1 --direction inbound`
- "找龙深运输的发票" -> `search 龙深运输`
- "导出本月发票" -> `export --month 2026-01 --format csv`
- "销项发票列表" -> `list --direction outbound`
- "未报销发票" -> `unreimbursed`
- "本月报销统计" -> `stats --month 2026-01`

## CLI Reference

| Command | Description |
|---------|-------------|
| `init` | Initialize database |
| `add --json '{...}' [--file path]` | Add invoice with optional file |
| `list [filters]` | List invoices |
| `get <id>` | Invoice detail |
| `update <id> --json '{...}'` | Update fields |
| `delete <id>` | Delete |
| `reimburse <id>` | Mark reimbursed |
| `unreimburse <id>` | Revert to unreimbursed |
| `unreimbursed` | List unreimbursed |
| `stats [filters]` | Statistics |
| `export [--format csv\|json]` | Export |
| `package --month YYYY-MM` | Zip month's invoices |
| `search <keyword>` | Search |
| `categories` | List categories |

Filters: `--month`, `--quarter`, `--year`, `--type`, `--direction`, `--category`, `--status`, `--reimbursement`, `--vendor`, `--limit`

## Rules

1. Always `init` before first use (idempotent)
2. Amounts in CNY unless stated otherwise
3. If vision extraction is uncertain, note it and set `status: 'pending'`
4. Never fabricate invoice numbers — if unreadable, ask the user
5. Process one invoice at a time for batch uploads
6. Date format: YYYY-MM-DD
7. Always save original files via `--file` when available
