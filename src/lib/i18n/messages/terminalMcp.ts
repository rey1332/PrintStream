import type { Entry } from './types';

// TERMINAL remote MCP, read only (P2, 20261012000048).
export const terminalMcpMessages = {
  'ps.conn.kind.mcp': {
    en: 'MCP server (remote)',
    id: 'Server MCP (remote)',
    zh: 'MCP 服务器（远程）',
  },
  'ps.conn.help.mcp': {
    en: 'A remote Model Context Protocol server (Streamable HTTP). PrintStream lists its tools; someone who manages connections approves each tool for reading before a sync may call it, and a tool the server changes must be approved again. Tool descriptions come from the server and are never followed as instructions.',
    id: 'Server Model Context Protocol jarak jauh (Streamable HTTP). PrintStream menampilkan daftar tool-nya; pengelola koneksi menyetujui setiap tool untuk dibaca sebelum sinkronisasi boleh memanggilnya, dan tool yang diubah server harus disetujui lagi. Deskripsi tool berasal dari server dan tidak pernah diikuti sebagai instruksi.',
    zh: '远程 Model Context Protocol 服务器（Streamable HTTP）。PrintStream 列出其工具；管理连接的成员需先批准某工具用于读取，同步才能调用它；服务器若更改工具，需重新批准。工具描述来自服务器，绝不会被当作指令执行。',
  },
  'ps.conn.field.mcp_url': {
    en: 'Server address (Streamable HTTP)',
    id: 'Alamat server (Streamable HTTP)',
    zh: '服务器地址（Streamable HTTP）',
  },
  'ps.conn.mcpOauthNote': {
    en: 'Addresses and client ID left empty are found from the server when you authorise.',
    id: 'Alamat dan client ID yang dikosongkan dicari dari server saat Anda mengotorisasi.',
    zh: '留空的地址和客户端 ID 将在授权时从服务器自动发现。',
  },

  'ps.mcp.tools': { en: 'Tools', id: 'Tool', zh: '工具' },
  'ps.mcp.toolsTitle': { en: 'Tools of {name}', id: 'Tool dari {name}', zh: '{name} 的工具' },
  'ps.mcp.refresh': { en: 'Ask the server again', id: 'Tanya server lagi', zh: '重新询问服务器' },
  'ps.mcp.noTools': {
    en: 'No tools listed yet. Test the connection or ask the server again.',
    id: 'Belum ada tool. Uji koneksi atau tanya server lagi.',
    zh: '尚未列出工具。请测试连接或重新询问服务器。',
  },
  'ps.mcp.descriptionNote': {
    en: 'Descriptions are the server’s own words: read them as claims, not as facts. PrintStream never follows them as instructions.',
    id: 'Deskripsi adalah kata-kata server sendiri: baca sebagai klaim, bukan fakta. PrintStream tidak pernah mengikutinya sebagai instruksi.',
    zh: '描述是服务器自己的说法：请视为声明而非事实。PrintStream 绝不会把它们当作指令执行。',
  },
  'ps.mcp.readOnly': { en: 'says read-only', id: 'menyatakan hanya-baca', zh: '声明为只读' },
  'ps.mcp.mayAct': { en: 'may change things', id: 'dapat mengubah sesuatu', zh: '可能会更改内容' },
  'ps.mcp.noHint': { en: 'no read-only hint', id: 'tanpa keterangan hanya-baca', zh: '无只读声明' },
  'ps.mcp.approved': { en: 'Approved for reading', id: 'Disetujui untuk dibaca', zh: '已批准读取' },
  'ps.mcp.changed': {
    en: 'Changed since it was approved',
    id: 'Berubah sejak disetujui',
    zh: '批准后已被更改',
  },
  'ps.mcp.notApproved': { en: 'Not approved', id: 'Belum disetujui', zh: '未批准' },
  'ps.mcp.approve': { en: 'Approve for reading', id: 'Setujui untuk dibaca', zh: '批准读取' },
  'ps.mcp.unapprove': { en: 'Withdraw approval', id: 'Cabut persetujuan', zh: '撤销批准' },
  'ps.mcp.approveConfirm': {
    en: 'Approve “{name}” for reading? Syncs may then call it with fixed arguments. Approve only tools that do not change anything; if the server changes the tool, the approval lapses.',
    id: 'Setujui “{name}” untuk dibaca? Sinkronisasi lalu boleh memanggilnya dengan argumen tetap. Setujui hanya tool yang tidak mengubah apa pun; jika server mengubah tool ini, persetujuan gugur.',
    zh: '批准“{name}”用于读取？之后同步可用固定参数调用它。请只批准不会更改任何内容的工具；若服务器更改该工具，批准将失效。',
  },
  'ps.mcp.schema': { en: 'Input schema', id: 'Skema input', zh: '输入结构' },
  'ps.mcp.listed': { en: 'listed {when}', id: 'didaftar {when}', zh: '列出于 {when}' },

  'ps.mcp.add': { en: 'Sync from the server', id: 'Sinkronkan dari server', zh: '从服务器同步' },
  'ps.mcp.step1': { en: 'Call', id: 'Panggilan', zh: '调用' },
  'ps.mcp.step2': { en: 'Columns', id: 'Kolom', zh: '列' },
  'ps.mcp.step': { en: 'Step {n} of 2', id: 'Langkah {n} dari 2', zh: '第 {n} 步，共 2 步' },
  'ps.mcp.what.tool': { en: 'An approved tool', id: 'Tool yang disetujui', zh: '已批准的工具' },
  'ps.mcp.what.resource': { en: 'A resource', id: 'Resource', zh: '资源' },
  'ps.mcp.tool': { en: 'Tool', id: 'Tool', zh: '工具' },
  'ps.mcp.pickTool': { en: 'Choose a tool', id: 'Pilih tool', zh: '选择工具' },
  'ps.mcp.noApproved': {
    en: 'No approved tools yet: approve one under Tools.',
    id: 'Belum ada tool yang disetujui: setujui di menu Tool.',
    zh: '尚无已批准的工具：请在“工具”中批准。',
  },
  'ps.mcp.resource': { en: 'Resource', id: 'Resource', zh: '资源' },
  'ps.mcp.pickResource': { en: 'Choose a resource', id: 'Pilih resource', zh: '选择资源' },
  'ps.mcp.loading': { en: 'Asking the server…', id: 'Menanyakan server…', zh: '正在询问服务器…' },
  'ps.mcp.arguments': { en: 'Arguments (JSON)', id: 'Argumen (JSON)', zh: '参数 (JSON)' },
  'ps.mcp.argumentsHint': {
    en: 'The same arguments are sent with every call.',
    id: 'Argumen yang sama dikirim di setiap panggilan.',
    zh: '每次调用都发送相同的参数。',
  },
  'ps.mcp.preview': { en: 'Call once', id: 'Panggil sekali', zh: '调用一次' },
  'ps.mcp.how': {
    en: 'Every run calls it again; rows are updated by the key (or replaced without one) and rows no longer returned are marked removed. The dataset’s lineage records the server and tool.',
    id: 'Setiap proses memanggilnya lagi; baris diperbarui berdasarkan kunci (atau diganti jika tanpa kunci) dan baris yang tidak lagi dikembalikan ditandai terhapus. Lineage dataset mencatat server dan tool-nya.',
    zh: '每次运行都会再次调用；行按键更新（无键则替换），不再返回的行标记为已删除。数据集的血缘记录服务器和工具。',
  },

  'ps.err.mcpSessionExpired': {
    en: 'The MCP server ended the session. Try again.',
    id: 'Server MCP mengakhiri sesi. Coba lagi.',
    zh: 'MCP 服务器结束了会话。请重试。',
  },
  'ps.err.mcpUnsupported': {
    en: 'The MCP server does not support this.',
    id: 'Server MCP tidak mendukung ini.',
    zh: 'MCP 服务器不支持此操作。',
  },
  'ps.err.mcpError': {
    en: 'The MCP server answered with an error: {detail}',
    id: 'Server MCP menjawab dengan galat: {detail}',
    zh: 'MCP 服务器返回错误：{detail}',
  },
  'ps.err.mcpToolError': {
    en: 'The tool reported an error: {detail}',
    id: 'Tool melaporkan galat: {detail}',
    zh: '工具报告错误：{detail}',
  },
  'ps.err.mcpToolMissing': {
    en: 'The server no longer lists this tool.',
    id: 'Server tidak lagi mencantumkan tool ini.',
    zh: '服务器已不再列出此工具。',
  },
  'ps.err.mcpToolUnapproved': {
    en: 'The tool is not approved as it is now (it may have changed). Approve it again under Tools.',
    id: 'Tool ini tidak disetujui dalam bentuknya sekarang (mungkin berubah). Setujui lagi di menu Tool.',
    zh: '此工具当前形态未获批准（可能已被更改）。请在“工具”中重新批准。',
  },
  'ps.err.mcpAuthDiscovery': {
    en: 'The server’s sign-in addresses could not be found. Fill them in under Advanced.',
    id: 'Alamat masuk server tidak ditemukan. Isi di bagian Lanjutan.',
    zh: '无法发现服务器的登录地址。请在“高级”中填写。',
  },
} satisfies Record<string, Entry>;
