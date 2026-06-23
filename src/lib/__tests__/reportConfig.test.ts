/**
 * Unit tests for src/lib/reportConfig.ts — export column picker logic (TASK 16).
 */
import {
  columnHeader,
  effectiveColumns,
  isColumnSelected,
  moveColumnDown,
  moveColumnUp,
  normalizeReportConfig,
  REPORT_COLUMNS,
  resetReportConfig,
  toggleColumn,
} from '../reportConfig';
import { DEFAULT_REPORT_CONFIG, type ReportConfig } from '../../types';

describe('normalizeReportConfig', () => {
  it('falls back to the default column set when empty/absent', () => {
    expect(normalizeReportConfig(undefined).columns).toEqual(DEFAULT_REPORT_CONFIG.columns);
    expect(normalizeReportConfig({ columns: [] } as Partial<ReportConfig>).columns).toEqual(
      DEFAULT_REPORT_CONFIG.columns,
    );
  });

  it('drops unknown ids and de-duplicates, preserving order', () => {
    const cfg = normalizeReportConfig({
      columns: ['vendor', 'bogus', 'date', 'vendor'] as never,
      mode: 'single',
      header: '',
    });
    expect(cfg.columns).toEqual(['vendor', 'date']);
  });

  it('clamps mode and coerces header to a string', () => {
    expect(normalizeReportConfig({ mode: 'weird' } as never).mode).toBe('single');
    expect(normalizeReportConfig({ mode: 'group' } as never).mode).toBe('group');
    expect(normalizeReportConfig({ header: 42 } as never).header).toBe('');
  });
});

describe('columnHeader', () => {
  it('maps every column id to a header', () => {
    for (const c of REPORT_COLUMNS) {
      expect(columnHeader(c.id)).toBe(c.header);
    }
  });
});

describe('effectiveColumns', () => {
  it('returns the selected order in single mode', () => {
    const cfg: ReportConfig = { columns: ['date', 'vendor', 'item'], mode: 'single', header: '' };
    expect(effectiveColumns(cfg)).toEqual(['date', 'vendor', 'item']);
  });

  it('omits line-item-only columns in group mode', () => {
    const cfg: ReportConfig = {
      columns: ['date', 'vendor', 'item', 'qty', 'unit_price', 'line_total', 'receipt_total'],
      mode: 'group',
      header: '',
    };
    expect(effectiveColumns(cfg)).toEqual(['date', 'vendor', 'receipt_total']);
  });
});

describe('toggleColumn', () => {
  const base: ReportConfig = { columns: ['date', 'vendor', 'tax'], mode: 'single', header: '' };

  it('removes a selected column', () => {
    expect(isColumnSelected(base, 'vendor')).toBe(true);
    const next = toggleColumn(base, 'vendor');
    expect(next.columns).toEqual(['date', 'tax']);
  });

  it('adds an unselected column in canonical order', () => {
    // 'memo' sits after 'tax' canonically -> appended; 'category' before 'tax'.
    const withMemo = toggleColumn(base, 'memo');
    expect(withMemo.columns).toEqual(['date', 'vendor', 'tax', 'memo']);
    const withCategory = toggleColumn(base, 'category');
    expect(withCategory.columns).toEqual(['date', 'vendor', 'category', 'tax']);
  });

  it('refuses to remove the last remaining column', () => {
    const single: ReportConfig = { columns: ['vendor'], mode: 'single', header: '' };
    expect(toggleColumn(single, 'vendor').columns).toEqual(['vendor']);
  });
});

describe('move up/down', () => {
  const cfg: ReportConfig = { columns: ['date', 'vendor', 'tax'], mode: 'single', header: '' };

  it('moves a column up', () => {
    expect(moveColumnUp(cfg, 'vendor').columns).toEqual(['vendor', 'date', 'tax']);
  });

  it('is a no-op moving the first column up', () => {
    expect(moveColumnUp(cfg, 'date').columns).toEqual(['date', 'vendor', 'tax']);
  });

  it('moves a column down', () => {
    expect(moveColumnDown(cfg, 'vendor').columns).toEqual(['date', 'tax', 'vendor']);
  });

  it('is a no-op moving the last column down', () => {
    expect(moveColumnDown(cfg, 'tax').columns).toEqual(['date', 'vendor', 'tax']);
  });
});

describe('resetReportConfig', () => {
  it('restores the full default', () => {
    const r = resetReportConfig();
    expect(r.columns).toEqual(DEFAULT_REPORT_CONFIG.columns);
    expect(r.mode).toBe('single');
    expect(r.header).toBe('');
  });
});
