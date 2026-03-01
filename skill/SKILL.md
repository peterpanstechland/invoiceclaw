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

### Step 3: Extract fields

**PDF files:** Use `node invoice-manager.mjs preview <id>` to extract text. Do NOT try to Read PDFs directly — they are binary files and will show garbled data.

**Image files:** Use your vision capability to view the file.

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

## Processing Email Invoices

### ⚠️ CRITICAL: Do NOT access the email inbox directly

Email polling is handled **entirely by the InvoiceClaw background service**. You MUST NOT:
- Connect to IMAP/POP3 servers
- Write scripts to read emails (no `check-email.js`, no `ImapFlow`, etc.)
- Access email credentials or `email-config.json`

The InvoiceClaw service automatically polls the inbox, downloads attachments (PDF/images), and creates **stub records** in the database with `amount: 0`, `status: 'pending'`, `source: 'email'`.

Your only job is to **analyze the already-downloaded files** using the `pending` command.

### When to check

- When the user says "查看邮件发票" / "check email invoices" / "处理未分析的发票" / "帮我看看邮箱里的发票"
- Proactively: check once daily or when starting a new conversation session

### Workflow

1. **List pending invoices:**
```bash
node invoice-manager.mjs pending --source email
```
This returns invoices that have `amount = 0` and `status = 'pending'`, including their `id`, `file_path`, and `notes` (email sender/subject).

If no pending invoices are found, tell the user: "当前没有待分析的邮件发票。邮件轮询服务会自动检查收件箱，您也可以在 InvoiceClaw 管理页面手动触发检查。"

2. **For each pending invoice:**
   - **PDF files:** Run `node invoice-manager.mjs preview <id>` to extract text content. Do NOT use the Read tool on PDFs — it will show garbled binary data.
   - **Image files:** View the file at `file_path` using your vision capability.
   - Apply the same extraction logic from Steps 1-3 above (identify type, direction, extract fields)
   - Update the record:
```bash
node invoice-manager.mjs update <id> --json '{
  "invoice_type": "general_invoice",
  "direction": "inbound",
  "amount": 1280.00,
  "tax_amount": 76.80,
  "vendor_name": "某某公司",
  "buyer_name": "我方公司",
  "invoice_date": "2026-01-15",
  "invoice_number": "12345678",
  "status": "verified"
}'
```

3. **Report results** to the user:
```
📧 邮件发票处理完成
已分析: 3 张  |  跳过: 0 张
  #42 | 普通发票 | 进项 | ¥1,280.00 | 某某公司
  #43 | 高铁票   | 进项 | ¥553.00   | 铁路客运
  #44 | 网约车   | 进项 | ¥28.50    | 高德打车
```

### Important notes

- If a file cannot be read or is not an invoice, set `"status": "rejected"` and add a note explaining why
- The `notes` field from the stub record contains the email sender and subject — use this as context if the image is ambiguous
- Do NOT re-process invoices that already have `status: 'verified'` or `status: 'rejected'`
- Email configuration (IMAP server, credentials, poll interval) is managed through the InvoiceClaw web UI Settings page, NOT through the agent

## Query Patterns

- "本月发票" -> `list --month 2026-01`
- "查看未分析发票" -> `pending` or `pending --source email`
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
| `pending [--source email] [--limit N]` | List unanalyzed invoices |
| `get <id>` | Invoice detail |
| `preview <id>` | Extract and display PDF text content |
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

Filters: `--month`, `--quarter`, `--year`, `--type`, `--direction`, `--category`, `--status`, `--reimbursement`, `--vendor`, `--source`, `--limit`

## Rules

1. Always `init` before first use (idempotent)
2. Amounts in CNY unless stated otherwise
3. If vision extraction is uncertain, note it and set `status: 'pending'`
4. Never fabricate invoice numbers — if unreadable, ask the user
5. Process one invoice at a time for batch uploads
6. Date format: YYYY-MM-DD
7. Always save original files via `--file` when available
