import 'reflect-metadata';
import { globSync } from 'node:fs';
import { join } from 'node:path';
import { plainToInstance, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayNotEmpty, ArrayUnique, getMetadataStorage, IsArray, IsBoolean, IsEmail, IsEnum,
  IsIn, IsInt, IsMongoId, IsNotEmpty, IsNumber, IsObject, IsString, Length, Matches, Max, MaxLength, Min, MinLength,
  validate, ValidateNested, type ValidationError,
} from 'class-validator';
import { readerIn, SOURCE_READER } from '@/common/i18n/reader';
import { render } from '@/common/i18n/sentence';
import { VALIDATION_REFUSALS } from './validation.messages';
import { field, legacyViolation, TRANSLATED_CONSTRAINTS, validationRefusal, violationsOf } from './violations';

const OWN = VALIDATION_REFUSALS.VALIDATION_FAILED.codeShape;

class Line {
  @IsString() code!: string;
  @Matches(/^[A-Z]+$/, { message: field(OWN) }) label!: string;
}

class Body {
  @IsString() name!: string;
  @MaxLength(5) short!: string;
  @MinLength(3) long!: string;
  @Length(2, 4) both!: string;
  @IsIn(['a', 'b']) pick!: string;
  @IsEnum({ X: 'x', Y: 'y' }) kind!: string;
  @Matches(/^\d+$/) digits!: string;
  @IsInt() whole!: number;
  @Min(0.01) least!: number;
  @Max(1000) most!: number;
  @IsArray() @ArrayMaxSize(1) @ArrayMinSize(1) list!: string[];
  @IsBoolean() flag!: boolean;
  @IsMongoId() id!: string;
  @IsObject() bag!: object;
  @IsNumber() n!: number;
  @IsNotEmpty() filled!: string;
  @IsEmail() email!: string;
  @ArrayUnique() unique!: string[];
  @ArrayNotEmpty() some!: string[];
  @IsString({ each: true }) tags!: string[];
  @ValidateNested({ each: true }) @Type(() => Line) lines!: Line[];
  @Matches(/^[A-Z][A-Z0-9_]+$/, { message: field(OWN) }) code!: string;
}

/** Every violation of a body, as the pipe would see it with the server's options. */
async function errorsOf(body: Record<string, unknown>): Promise<ValidationError[]> {
  return validate(plainToInstance(Body, body), { whitelist: true, forbidNonWhitelisted: true });
}

const BAD = {
  // `both` is no string at all: Length then names both bounds.
  name: 1, short: 'toolong', long: 'a', both: 5, pick: 'c', kind: 'z', digits: 'x1', whole: 1.5, least: 0, most: 2000,
  list: ['a', 'b'], flag: 'yes', id: 'nope', bag: 'str', n: 'one', filled: '', email: 'x', unique: ['a', 'a'], some: [],
  tags: [1], lines: [{ code: 2, label: 'lower' }], code: '1bad', extra: true,
};

/**
 * **P18.10-T5 AC-3 — the pipe's refusals in the reader's language** (ADR-0179 §7): every violation class-validator
 * writes, the English exactly as the pipe wrote it before and its Indonesian read off the same template; a DTO's own
 * sentence (`field`) in both languages; a nested property under its path.
 */
describe('P18.10-T5 AC-3 the pipe’s violations', () => {
  let english: string[];
  let indonesian: string[];

  beforeAll(async () => {
    const violations = violationsOf(await errorsOf(BAD));
    english = violations.map((v) => render(v, SOURCE_READER));
    indonesian = violations.map((v) => render(v, readerIn('id')));
  });

  it('AC-3 keeps class-validator’s English, every word of it, in Nest’s order', () => {
    expect(english).toEqual(expect.arrayContaining([
      'name must be a string',
      'short must be shorter than or equal to 5 characters',
      'long must be longer than or equal to 3 characters',
      'both must be longer than or equal to 2 and shorter than or equal to 4 characters',
      'pick must be one of the following values: a, b',
      'kind must be one of the following values: x, y',
      'digits must match /^\\d+$/ regular expression',
      'whole must be an integer number',
      'least must not be less than 0.01',
      'most must not be greater than 1000',
      'list must contain no more than 1 elements',
      'flag must be a boolean value',
      'id must be a mongodb id',
      'bag must be an object',
      'n must be a number conforming to the specified constraints',
      'filled should not be empty',
      'email must be an email',
      "All unique's elements must be unique",
      'some should not be empty',
      'each value in tags must be a string',
      'lines.0.code must be a string',
      'lines.0.A code is 3–40 characters of A–Z, 0–9 and underscore, starting with a letter.',
      'A code is 3–40 characters of A–Z, 0–9 and underscore, starting with a letter.',
      'property extra should not exist',
    ]));
  });

  it('AC-3 says each in Indonesian, the field named as the API names it', () => {
    expect(indonesian).toEqual(expect.arrayContaining([
      'name harus berupa teks',
      'short paling banyak 5 karakter',
      'long paling sedikit 3 karakter',
      'both harus 2 sampai 4 karakter',
      'pick harus salah satu dari nilai berikut: a, b',
      'kind harus salah satu dari nilai berikut: x, y',
      'digits harus sesuai dengan pola /^\\d+$/',
      'whole harus berupa bilangan bulat',
      'least tidak boleh kurang dari 0,01',
      'most tidak boleh lebih dari 1.000',
      'list paling banyak berisi 1 item',
      'flag harus bernilai true atau false',
      'id harus berupa ID yang valid',
      'bag harus berupa objek',
      'n harus berupa angka',
      'filled tidak boleh kosong',
      'email harus berupa alamat email',
      'Setiap item di unique harus berbeda',
      'some tidak boleh kosong',
      'setiap nilai di tags harus berupa teks',
      'lines.0.code harus berupa teks',
      'lines.0.Kode terdiri dari 3–40 karakter A–Z, 0–9 dan garis bawah, diawali huruf.',
      'Kode terdiri dari 3–40 karakter A–Z, 0–9 dan garis bawah, diawali huruf.',
      'properti extra tidak dikenal',
    ]));
    expect(indonesian).toHaveLength(english.length);
  });

  it('AC-3 reads the other Length sentences, and an array too short', async () => {
    class Lengths {
      @Length(2, 4) a!: string;
      @Length(2, 4) b!: string;
      @ArrayMinSize(2) c!: string[];
    }
    const errors = await validate(plainToInstance(Lengths, { a: 'x', b: 'xxxxxx', c: ['one'] }));
    const said = violationsOf(errors).map((v) => [render(v, SOURCE_READER), render(v, readerIn('id'))]);
    expect(said).toEqual(expect.arrayContaining([
      ['a must be longer than or equal to 2 characters', 'a paling sedikit 2 karakter'],
      ['b must be shorter than or equal to 4 characters', 'b paling banyak 4 karakter'],
      ['c must contain at least 2 elements', 'c paling sedikit berisi 2 item'],
    ]));
  });

  it('AC-3 answers a nested property that is not an object, and an unknown value, in Indonesian', async () => {
    class Holder {
      @ValidateNested() @Type(() => Line) line!: Line;
    }
    const [nested] = violationsOf(await validate(plainToInstance(Holder, { line: 'flat' })));
    expect(render(nested, readerIn('id'))).toBe('properti line harus berupa objek atau daftar');
    const unknown = violationsOf([{ property: 'x', constraints: { unknownValue: 'an unknown value was passed to the validate function' }, children: [] } as ValidationError]);
    expect(render(unknown[0], readerIn('id'))).toBe('nilai yang dikirim tidak dikenal');
  });

  it('AC-3 still answers Indonesian for a sentence no template reads, naming the field', () => {
    const [own] = violationsOf([{ property: 'when', constraints: { isTomorrow: 'when must be tomorrow' }, children: [] } as ValidationError]);
    expect(render(own, SOURCE_READER)).toBe('when must be tomorrow');
    expect(render(own, readerIn('id'))).toBe('when tidak valid');
    const [odd] = violationsOf([{ property: 'n', constraints: { min: 'n is too small' }, children: [] } as ValidationError]);
    expect(render(odd, readerIn('id'))).toBe('n tidak valid');
  });

  it('AC-3 reads a list Nest wrote by its words, as class-validator’s', () => {
    expect(render(legacyViolation('name must be a string'), readerIn('id'))).toBe('name harus berupa teks');
    expect(render(legacyViolation('items.0.code must be a string'), readerIn('id'))).toBe('items.0.code harus berupa teks');
    expect(render(legacyViolation('something odd'), readerIn('id'))).toBe('value tidak valid');
    expect(render(legacyViolation('something odd'), SOURCE_READER)).toBe('something odd');
  });

  it('AC-3 refuses 400 VALIDATION_FAILED with every violation, joined, in English on the exception', async () => {
    const refusal = validationRefusal(await errorsOf({ ...BAD, extra: undefined }));
    expect(refusal.code).toBe('VALIDATION_FAILED');
    expect(refusal.getStatus()).toBe(400);
    const violations = (refusal.details as { violations: string[] }).violations;
    expect(violations).toContain('name must be a string');
    expect(refusal.message).toBe(violations.join('; '));
    const written = refusal.detailsFor(readerIn('id')) as { violations: string[] };
    expect(written.violations).toContain('name harus berupa teks');
    expect(refusal.messageFor(readerIn('id'))).toBe(written.violations.join('; '));
  });
});

/**
 * **Every DTO's violations read in Indonesian** (P18.10-T5 AC-3): each constraint any DTO declares is one this reads by
 * its template, and every message a DTO writes itself is a `field(...)` sentence in both languages. Read off
 * class-validator's own metadata, after loading every DTO and controller the API has.
 */
describe('P18.10-T5 AC-3 every DTO’s violations', () => {
  const SRC = join(__dirname, '../..');
  const files = globSync('**/*.{dto,controller}.ts', { cwd: SRC }).filter((file) => !file.includes('.spec.'));

  beforeAll(() => {
    for (const file of files) require(join(SRC, file));
  });

  type Metadata = {
    type: string; name?: string; target: { name?: string }; propertyName: string; message?: unknown;
    constraintCls?: unknown;
  };
  const metadatas = (): Metadata[] => {
    const storage = getMetadataStorage() as unknown as { validationMetadatas: Map<unknown, Metadata[]> };
    return [...storage.validationMetadatas.values()].flat();
  };
  const constraintName = (metadata: Metadata): string | undefined => {
    const storage = getMetadataStorage() as unknown as {
      getTargetValidatorConstraints(cls: unknown): { name: string }[];
    };
    return metadata.constraintCls ? storage.getTargetValidatorConstraints(metadata.constraintCls)[0]?.name : undefined;
  };

  it('loads the API’s DTOs and controllers', () => {
    expect(files.length).toBeGreaterThan(40);
    expect(metadatas().length).toBeGreaterThan(300);
  });

  it('AC-3 writes every DTO’s own message in both languages (`field`)', () => {
    const plain = metadatas()
      // `@ValidateNested` writes class-validator's own sentence as its message, read by its template.
      .filter((m) => m.message !== undefined && m.type !== 'nestedValidation')
      .filter((m) => {
        const text = typeof m.message === 'function' ? (m.message as (a: unknown) => string)({}) : m.message;
        return !(typeof text === 'string' && text.startsWith('i18n:'));
      })
      .map((m) => `${m.target.name}.${m.propertyName}`);
    expect(plain).toEqual([]);
  });

  it('AC-3 reads every constraint a DTO declares by its template, or by its own `field` sentence', () => {
    const unread = metadatas()
      .filter((m) => m.type === 'customValidation')
      .filter((m) => m.message === undefined)
      .map((m) => ({ at: `${m.target.name}.${m.propertyName}`, name: constraintName(m) }))
      .filter(({ name }) => name === undefined || !TRANSLATED_CONSTRAINTS.includes(name))
      .map(({ at, name }) => `${at}: ${name}`);
    // A custom decorator's own default message counts as its sentence once it is a `field(...)`.
    // P19.4-T5: `isRungMap`, *Salin dari…*'s rung map (ADR-0213 §4), says `rungMapShape`.
    const ownDefaults = new Set(['isOfficeDate', 'isTemplateFrom', 'isRungMap']);
    expect(unread.filter((line) => !ownDefaults.has(line.split(': ')[1]))).toEqual([]);
  });
});
