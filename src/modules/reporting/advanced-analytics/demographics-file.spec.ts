import { dayFromFile, dayToFile, demographicsFile, readDemographicsFile, workStatusFromFile } from './demographics-file';

describe('P19.22-T2 Demografi’s list and upload file (ADR-0275 §2; OD-413)', () => {
  it('P19.22-T2 AC-1 writes the header, then one row per member, dates dd/mm/yyyy, a formula-like name as text', () => {
    const file = demographicsFile([
      { agentCode: '70001', name: 'Dewi, Lestari', role: 'AGENT', upline: 'Agus', workStatus: 'full_time', dateOfBirth: '1990-01-02', joinDate: null },
      { agentCode: '70002', name: '=HACK()', role: 'AB', upline: '', workStatus: null, dateOfBirth: null, joinDate: '2016-05-01' },
    ]);
    expect(file.split('\r\n')).toEqual([
      'Kode agen,Nama,Peran,Upline,Status kerja,Tanggal lahir,Tanggal bergabung',
      '70001,"Dewi, Lestari",AGENT,Agus,Full-time,02/01/1990,',
      "70002,'=HACK(),AB,,,,01/05/2016",
      '',
    ]);
    expect(dayToFile(null)).toBe('');
  });

  it('P19.22-T2 AC-1 reads the rows back by the header’s names, any order and delimiter; an empty cell is no change', () => {
    const rows = readDemographicsFile('﻿tanggal lahir;KODE AGEN;Status Kerja\n02/01/1990;70001;\n\n;70002;Part-time\n');
    expect(rows).toEqual([
      { line: 2, agentCode: '70001', workStatus: undefined, dateOfBirth: '02/01/1990', joinDate: undefined },
      { line: 4, agentCode: '70002', workStatus: 'Part-time', dateOfBirth: undefined, joinDate: undefined },
    ]);
    expect(readDemographicsFile('Nama,Status kerja\nX,Full-time\n')).toBeNull();
  });

  it('P19.22-T2 AC-1 an empty file has no Kode agen; a row that stops early reads its missing cells as empty', () => {
    expect(readDemographicsFile('')).toBeNull();
    // A spreadsheet drops the trailing empty cells, and a row may carry fewer cells than the header — the code's among them.
    expect(readDemographicsFile('Status kerja,Tanggal lahir,Kode agen\nFull-time\n')).toEqual([
      { line: 2, agentCode: '', workStatus: 'Full-time', dateOfBirth: undefined, joinDate: undefined },
    ]);
  });

  it('P19.22-T2 AC-1 Full-time / Part-time in either language; a real date only', () => {
    expect(workStatusFromFile('Full-time')).toBe('full_time');
    expect(workStatusFromFile('paruh waktu')).toBe('part_time');
    expect(workStatusFromFile('kadang')).toBeNull();
    expect(dayFromFile('2/1/1990')).toBe('1990-01-02');
    expect(dayFromFile('1990-01-02')).toBe('1990-01-02');
    expect(dayFromFile('31/02/1990')).toBeNull();
    expect(dayFromFile('Jan 1990')).toBeNull();
  });
});
