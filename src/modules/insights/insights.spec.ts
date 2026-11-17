import { dashboardPeriod } from './dashboard.service';
import { EXCEPTION_TEXT, exceptionText } from './review.service';

describe('dashboardPeriod (D-122)', () => {
  it('no date or month: everything still waiting', () => {
    expect(dashboardPeriod({})).toBeNull();
  });

  it('a date: that day for Daily rows, its month for Monthly rows', () => {
    expect(dashboardPeriod({ date: '2026-10-15' })).toEqual({
      from: '2026-10-15',
      to: '2026-10-15',
      monthFrom: '2026-10-01',
      monthTo: '2026-10-01',
    });
  });

  it('a month: every day of it, and that month', () => {
    expect(dashboardPeriod({ month: '2026-02' })).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
      monthFrom: '2026-02-01',
      monthTo: '2026-02-01',
    });
  });
});

describe('exceptionText (MR-5)', () => {
  const base = {
    id: 'x',
    plantId: 'p',
    reportDate: new Date('2026-10-15T00:00:00Z'),
    problemHighlight: null,
  };

  it('no report: “report not submitted”', () => {
    expect(exceptionText(undefined)).toEqual({
      text: EXCEPTION_TEXT.notSubmitted,
      status: 'NOT_INITIATED',
      id: null,
    });
  });

  it('Completed is clean; Pending shows the first Yes remark', () => {
    expect(exceptionText({ ...base, status: 'COMPLETED', lines: [] }).text).toBe(
      EXCEPTION_TEXT.clean,
    );
    expect(
      exceptionText({
        ...base,
        status: 'PENDING',
        problemHighlight: 'Jockey pump no. 2 on manual',
        lines: [{ lineNo: 3, answer: 'YES' }],
      }).text,
    ).toBe('Jockey pump no. 2 on manual');
    expect(
      exceptionText({ ...base, status: 'PENDING', lines: [{ lineNo: 12, answer: 'YES' }] }).text,
    ).toBe('Yes — line 12');
  });

  it('Partial says how many lines are answered', () => {
    expect(
      exceptionText({
        ...base,
        status: 'PARTIAL',
        lines: [
          { lineNo: 1, answer: 'NO' },
          { lineNo: 2, answer: 'NO' },
        ],
      }).text,
    ).toBe('Partial — 2 of 13 lines answered');
  });
});
