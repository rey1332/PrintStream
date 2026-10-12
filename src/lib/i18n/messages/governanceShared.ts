import type { Entry } from './types';

// Words shared by the admin panel and the ERP (governance settings, announcements).
export const governanceSharedMessages = {
  'padmin.log.empty': {
    en: 'No events match.',
    id: 'Tidak ada peristiwa yang cocok.',
    zh: '没有匹配的事件。',
  },
  'gov.forever': { en: 'forever', id: 'selamanya', zh: '永久' },
  'gov.log.security': { en: 'Security log', id: 'Log keamanan', zh: '安全日志' },
  'gov.log.data_access': { en: 'Data-access log', id: 'Log akses data', zh: '数据访问日志' },
  'gov.log.workspace_audit': {
    en: 'Workspace activity',
    id: 'Aktivitas ruang kerja',
    zh: '工作区活动',
  },
  'gov.log.run_history': {
    en: 'Pipeline run history',
    id: 'Riwayat run pipeline',
    zh: '管道运行记录',
  },
  'gov.log.stream_raw': {
    en: 'Raw streamed events',
    id: 'Event streaming mentah',
    zh: '原始流事件',
  },
  'gov.accessLog': { en: 'Data access', id: 'Akses data', zh: '数据访问' },
  'gov.actor.staff': { en: 'ETNA staff', id: 'Staf ETNA', zh: 'ETNA 员工' },
  'erp.announcement.dismiss': { en: 'Hide', id: 'Sembunyikan', zh: '隐藏' },
} satisfies Record<string, Entry>;
