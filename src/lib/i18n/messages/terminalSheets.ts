import type { Entry } from './types';

// Terminal spreadsheets online (P2, 20261012000063).
export const terminalSheetsMessages = {
  'ps.conn.kind.sheets': {
    en: 'Google Sheets / Excel online',
    id: 'Google Sheets / Excel online',
    zh: 'Google 表格 / Excel 在线版',
  },
  'ps.conn.help.sheets': {
    en: 'Tabs of a Google Sheet, or of an Excel workbook in OneDrive or SharePoint, synced into datasets without uploading files. Google: a sheet anyone with the link may view needs nothing; a private sheet is shared (as Viewer) with a service account whose JSON key you give here. Microsoft: an app registration in Microsoft Entra with the Files.Read.All application permission (admin consent).',
    id: 'Tab Google Sheet, atau workbook Excel di OneDrive atau SharePoint, disinkronkan ke dataset tanpa upload file. Google: sheet yang bisa dilihat siapa saja dengan link tidak butuh apa-apa; sheet privat dibagikan (sebagai Viewer) ke service account yang JSON key-nya Anda isi di sini. Microsoft: app registration di Microsoft Entra dengan izin aplikasi Files.Read.All (persetujuan admin).',
    zh: '将 Google 表格或 OneDrive / SharePoint 中 Excel 工作簿的工作表同步为数据集，无需上传文件。Google：任何知道链接者可查看的表格无需设置；私有表格需以“查看者”身份共享给服务账号，并在此填写其 JSON 密钥。Microsoft：在 Microsoft Entra 中注册应用，授予 Files.Read.All 应用权限（管理员同意）。',
  },
  'ps.conn.field.provider': { en: 'Provider', id: 'Penyedia', zh: '提供方' },
  'ps.conn.opt.google': { en: 'Google Sheets', id: 'Google Sheets', zh: 'Google 表格' },
  'ps.conn.opt.microsoft': {
    en: 'Excel (OneDrive / SharePoint)',
    id: 'Excel (OneDrive / SharePoint)',
    zh: 'Excel（OneDrive / SharePoint）',
  },
  'ps.conn.field.google_auth': { en: 'Access', id: 'Akses', zh: '访问方式' },
  'ps.conn.opt.link': {
    en: 'Anyone with the link can view',
    id: 'Siapa saja dengan link bisa melihat',
    zh: '任何知道链接的人可查看',
  },
  'ps.conn.opt.service_account': {
    en: 'Shared with a service account (private)',
    id: 'Dibagikan ke service account (privat)',
    zh: '共享给服务账号（私有）',
  },
  'ps.conn.field.service_account_json': {
    en: 'Service account key (JSON)',
    id: 'Key service account (JSON)',
    zh: '服务账号密钥（JSON）',
  },
  'ps.conn.field.tenant_id': {
    en: 'Tenant (ID or domain)',
    id: 'Tenant (ID atau domain)',
    zh: '租户（ID 或域名）',
  },

  'ps.sheet.add': { en: 'Sync a sheet', id: 'Sinkronkan sheet', zh: '同步工作表' },
  'ps.sheet.step': { en: 'Step {n} of 2', id: 'Langkah {n} dari 2', zh: '第 {n} 步，共 2 步' },
  'ps.sheet.step1': { en: 'The sheet', id: 'Sheet', zh: '工作表' },
  'ps.sheet.step2': { en: 'Columns', id: 'Kolom', zh: '列' },
  'ps.sheet.urlGoogle': {
    en: 'Address of the Google Sheet',
    id: 'Alamat Google Sheet',
    zh: 'Google 表格地址',
  },
  'ps.sheet.urlMicrosoft': {
    en: 'Sharing link of the workbook (OneDrive or SharePoint)',
    id: 'Link berbagi workbook (OneDrive atau SharePoint)',
    zh: '工作簿的共享链接（OneDrive 或 SharePoint）',
  },
  'ps.sheet.urlHintLink': {
    en: 'In Google Sheets: Share → General access → Anyone with the link (Viewer), then copy the address. The tab in the address is read unless you name one.',
    id: 'Di Google Sheets: Bagikan → Akses umum → Siapa saja yang memiliki link (Pelihat), lalu salin alamatnya. Tab di alamat itu yang dibaca, kecuali Anda menyebut tab lain.',
    zh: '在 Google 表格中：共享 → 一般访问权限 → 知道链接的任何人（查看者），然后复制地址。除非另行指定，读取地址中的工作表。',
  },
  'ps.sheet.urlHintService': {
    en: 'Share the sheet (Viewer) with the service account’s e-mail address shown on the connection, then copy the sheet’s address.',
    id: 'Bagikan sheet (Pelihat) ke alamat e-mail service account yang tampil di koneksi, lalu salin alamat sheet.',
    zh: '将表格以“查看者”身份共享给连接上显示的服务账号邮箱，然后复制表格地址。',
  },
  'ps.sheet.urlHintMicrosoft': {
    en: 'In Excel: Share → Copy link. The app registration reads it with its own permission; personal OneDrive accounts are not supported.',
    id: 'Di Excel: Bagikan → Salin link. App registration membacanya dengan izinnya sendiri; akun OneDrive pribadi tidak didukung.',
    zh: '在 Excel 中：共享 → 复制链接。应用注册以其自身权限读取；不支持个人 OneDrive 账户。',
  },
  'ps.sheet.tab': { en: 'Tab', id: 'Tab', zh: '工作表' },
  'ps.sheet.firstTab': { en: 'The first tab', id: 'Tab pertama', zh: '第一个工作表' },
  'ps.sheet.range': { en: 'Range (optional)', id: 'Rentang (opsional)', zh: '范围（可选）' },
  'ps.sheet.headerRow': { en: 'Header row', id: 'Baris judul', zh: '标题行' },
  'ps.sheet.read': { en: 'Read the sheet', id: 'Baca sheet', zh: '读取工作表' },
  'ps.sheet.badUrl': {
    en: 'This is not an address of this kind of sheet, or the range is not like A1:H500.',
    id: 'Ini bukan alamat sheet jenis ini, atau rentangnya tidak seperti A1:H500.',
    zh: '这不是此类表格的地址，或范围格式不像 A1:H500。',
  },
  'ps.sheet.noRows': {
    en: 'The sheet has no rows under the header row.',
    id: 'Sheet tidak punya baris di bawah baris judul.',
    zh: '标题行下方没有数据行。',
  },

  'ps.err.sheetNotShared': {
    en: 'The sheet cannot be opened: share it as described (anyone with the link, the service account, or the app registration’s access), then try again.',
    id: 'Sheet tidak bisa dibuka: bagikan sesuai petunjuk (siapa saja dengan link, service account, atau akses app registration), lalu coba lagi.',
    zh: '无法打开表格：请按说明共享（知道链接的任何人、服务账号或应用注册的访问权限），然后重试。',
  },
  'ps.err.sheetNotFound': {
    en: 'The workbook has no tab with this name.',
    id: 'Workbook tidak punya tab dengan nama ini.',
    zh: '工作簿中没有此名称的工作表。',
  },
  'ps.err.notAWorkbook': {
    en: 'The link is not to an Excel workbook (.xlsx).',
    id: 'Link ini bukan ke workbook Excel (.xlsx).',
    zh: '该链接不是 Excel 工作簿（.xlsx）。',
  },
  'ps.err.sheetTooLarge': {
    en: 'The sheet is too large (more than {max} rows): pick a range.',
    id: 'Sheet terlalu besar (lebih dari {max} baris): pilih rentangnya.',
    zh: '表格过大（超过 {max} 行）：请选择范围。',
  },
} satisfies Record<string, Entry>;
