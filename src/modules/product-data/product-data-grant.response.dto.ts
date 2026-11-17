import { ApiProperty } from '@nestjs/swagger';
import type {
  GrantCompany, ProductDataChangeRow, ProductDataChangesPage, ProductDataGrantRevoked, ProductDataGrantRow,
} from './product-data-grant.service';
import type { ReadableCompanies, ReadableCompany } from './product-data-companies.service';

/** One insurer, by id and name. */
export class GrantCompanyDto implements GrantCompany {
  @ApiProperty({ type: String }) companyId!: string;
  @ApiProperty({ type: String }) name!: string;
}

/** `GET`/`PUT /admin/product-data-grants…`: one person's *Kelola data produk* (ADR-0260 §4). */
export class ProductDataGrantRowDto implements ProductDataGrantRow {
  @ApiProperty({ type: String }) userId!: string;
  @ApiProperty({ type: String }) fullName!: string;
  @ApiProperty({ type: String }) email!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Their KPM now; `null` when they are an Owner or Admin of none.' })
  kpmId!: string | null;

  @ApiProperty({ type: String, nullable: true }) kpmLabel!: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'Whether it grants anything today: they are an active KPM Owner or KPM Admin (ADR-0260 §2).',
  })
  holds!: boolean;

  @ApiProperty({ type: () => GrantCompanyDto, isArray: true, description: 'The insurers ticked, A to Z.' })
  companies!: GrantCompanyDto[];

  @ApiProperty({ type: String, format: 'date-time' }) grantedAt!: string;
  @ApiProperty({ type: String, nullable: true }) grantedByName!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}

/** `DELETE /admin/product-data-grants/:userId`: removed, at once. */
export class ProductDataGrantRevokedDto implements ProductDataGrantRevoked {
  @ApiProperty({ type: String }) userId!: string;
  @ApiProperty({ type: String, format: 'date-time' }) revokedAt!: string;
}

/** One line of *Perubahan oleh pengelola* (ADR-0260 §6). */
export class ProductDataChangeRowDto implements ProductDataChangeRow {
  @ApiProperty({ type: String, description: 'The audit row it is.' }) auditId!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String }) action!: string;
  @ApiProperty({ type: String, description: 'The action in the reader’s words.' }) actionLabel!: string;
  @ApiProperty({ type: String }) targetCollection!: string;
  @ApiProperty({ type: String }) targetKind!: string;
  @ApiProperty({ type: String, nullable: true }) targetId!: string | null;
  @ApiProperty({ type: String }) actorUserId!: string;
  @ApiProperty({ type: String, nullable: true }) actorName!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'The scope the row was written in: the manager’s KPM.' })
  kpmId!: string | null;

  @ApiProperty({ type: String, nullable: true }) officeLabel!: string | null;
  @ApiProperty({ type: String, nullable: true }) companyId!: string | null;
  @ApiProperty({ type: String, nullable: true }) companyName!: string | null;
  @ApiProperty({ type: String, nullable: true }) productId!: string | null;
  @ApiProperty({ type: String, nullable: true }) productName!: string | null;
}

export class ProductDataChangesCursorDto {
  @ApiProperty({ type: String, nullable: true }) cursor!: string | null;
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty({ type: Number }) limit!: number;
  @ApiProperty({ type: Boolean }) hasMore!: boolean;
}

/** `GET /admin/product-data-grants/changes`: a page of *Perubahan oleh pengelola*, newest first. */
export class ProductDataChangesPageDto implements ProductDataChangesPage {
  @ApiProperty({ type: () => ProductDataChangeRowDto, isArray: true }) items!: ProductDataChangeRowDto[];
  @ApiProperty({ type: () => ProductDataChangesCursorDto }) page!: ProductDataChangesCursorDto;
}

/** One company the reader may open on *Data produk* (ADR-0260 §5). */
export class ReadableCompanyDto implements ReadableCompany {
  @ApiProperty({ type: String }) companyId!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: Boolean, description: 'The full tab (`true`) or read-only (`false`).' }) canManage!: boolean;
  @ApiProperty({ type: Boolean, description: 'The company of the reader’s own KPM.' }) own!: boolean;
}

/** `GET /product-data/companies`: every company the reader may open on *Data produk*, theirs first, then A to Z. */
export class ReadableCompaniesDto implements ReadableCompanies {
  @ApiProperty({ type: () => ReadableCompanyDto, isArray: true }) items!: ReadableCompanyDto[];
}
