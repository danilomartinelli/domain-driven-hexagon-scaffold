import { publishDomainEvents } from '../application/publish-domain-events';
import { RequestContextService } from '../application/context/AppRequestContext';
import {
  AggregateRoot,
  type PaginatedQueryParams,
  Paginated,
} from '@starter/core/domain';
import type { Mapper } from '@starter/core/domain';
import type { RepositoryPort } from '@starter/core/domain';
import { ConflictException } from '@starter/core/errors';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { None, Option, Some } from 'oxide.ts';
import { sql, UniqueIntegrityConstraintViolationError } from 'slonik';
import type {
  DatabasePool,
  DatabaseTransactionConnection,
  IdentifierSqlToken,
  PrimitiveValueExpression,
  QuerySqlToken,
  ValueExpression,
} from 'slonik';
import type { ZodType } from 'zod';
import type { LoggerPort } from '@starter/core/logger';

export abstract class SqlRepositoryBase<
  Aggregate extends AggregateRoot<unknown>,
  DbModel extends Record<string, PrimitiveValueExpression | Date | undefined>,
> implements RepositoryPort<Aggregate> {
  protected abstract tableName: string;

  protected abstract schema: ZodType<DbModel>;

  protected constructor(
    private readonly _pool: DatabasePool,
    protected readonly mapper: Mapper<Aggregate, DbModel>,
    protected readonly eventEmitter: EventEmitter2,
    protected readonly logger: LoggerPort,
  ) {}

  async findOneById(id: string): Promise<Option<Aggregate>> {
    const query = sql.type(this.schema)`SELECT * FROM ${sql.identifier([
      this.tableName,
    ])} WHERE id = ${id}`;

    const result = await this.pool.query(query);
    return result.rows[0] ? Some(this.mapper.toDomain(result.rows[0])) : None;
  }

  async findAll(): Promise<Aggregate[]> {
    const query = sql.type(this.schema)`SELECT * FROM ${sql.identifier([
      this.tableName,
    ])}`;

    const result = await this.pool.query(query);

    return result.rows.map((record) => this.mapper.toDomain(record));
  }

  async findAllPaginated(
    params: PaginatedQueryParams,
  ): Promise<Paginated<Aggregate>> {
    const query = sql.type(this.schema)`
    SELECT * FROM ${sql.identifier([this.tableName])}
    LIMIT ${params.limit}
    OFFSET ${params.offset}
    `;

    const result = await this.pool.query(query);

    const entities = result.rows.map((record) => this.mapper.toDomain(record));
    return new Paginated({
      data: entities,
      count: result.rowCount,
      limit: params.limit,
      page: params.page,
    });
  }

  async delete(entity: Aggregate): Promise<boolean> {
    entity.validate();
    const query = sql.unsafe`DELETE FROM ${sql.identifier([
      this.tableName,
    ])} WHERE id = ${entity.id}`;

    this.logger.debug(
      `[${RequestContextService.getRequestId()}] deleting entities ${
        entity.id
      } from ${this.tableName}`,
    );

    const result = await this.pool.query(query);

    await publishDomainEvents(
      entity,
      RequestContextService.getRequestId(),
      this.logger,
      this.eventEmitter,
    );

    return result.rowCount > 0;
  }

  /**
   * Inserts an entity to a database
   * (also publishes domain events and waits for completion)
   */
  async insert(entity: Aggregate | Aggregate[]): Promise<void> {
    const entities = Array.isArray(entity) ? entity : [entity];

    const records = entities.map((item) => this.mapper.toPersistence(item));

    const query = this.generateInsertQuery(records);

    try {
      await this.writeQuery(query, entities);
    } catch (error) {
      if (error instanceof UniqueIntegrityConstraintViolationError) {
        this.logger.debug(
          `[${RequestContextService.getRequestId()}] ${String(error.detail)}`,
        );
        throw new ConflictException('Record already exists', error);
      }
      throw error;
    }
  }

  /**
   * Utility method for write queries when you need to mutate an entity.
   * Executes entity validation, publishes events,
   * and does some debug logging.
   * For read queries use `this.pool` directly
   */
  protected async writeQuery(
    query: QuerySqlToken,
    entity: Aggregate | Aggregate[],
  ): Promise<void> {
    const entities = Array.isArray(entity) ? entity : [entity];
    entities.forEach((entity) => {
      entity.validate();
    });
    const entityIds = entities.map((e) => e.id);

    this.logger.debug(
      `[${RequestContextService.getRequestId()}] writing ${String(
        entities.length,
      )} entities to "${this.tableName}" table: ${entityIds.join(',')}`,
    );

    await this.pool.query(query);

    await Promise.all(
      entities.map((entity) =>
        publishDomainEvents(
          entity,
          RequestContextService.getRequestId(),
          this.logger,
          this.eventEmitter,
        ),
      ),
    );
  }

  /**
   * Utility method to generate insert query for any objects.
   * Use carefully and don't accept non-validated objects.
   *
   * Passing object with { name: string, email: string } will generate
   * a query: INSERT INTO "table" (name, email) VALUES ($1, $2)
   */
  protected generateInsertQuery(models: DbModel[]): QuerySqlToken {
    // TODO: generate query from an entire array to insert multiple records at once
    const entries = Object.entries(models[0]);
    const values: ValueExpression[] = [];
    const propertyNames: IdentifierSqlToken[] = [];

    entries.forEach((entry) => {
      if (entry[0] && entry[1] !== undefined) {
        propertyNames.push(sql.identifier([entry[0]]));
        if (entry[1] instanceof Date) {
          values.push(sql.timestamp(entry[1]));
        } else {
          values.push(entry[1]);
        }
      }
    });

    const query = sql.unsafe`INSERT INTO ${sql.identifier([
      this.tableName,
    ])} (${sql.join(propertyNames, sql.fragment`, `)}) VALUES (${sql.join(
      values,
      sql.fragment`, `,
    )})`;

    return query;
  }

  /**
   * start a global transaction to save
   * results of all event handlers in one operation
   */
  public async transaction<T>(handler: () => Promise<T>): Promise<T> {
    return this.pool.transaction(async (connection) => {
      this.logger.debug(
        `[${RequestContextService.getRequestId()}] transaction started`,
      );
      if (!RequestContextService.getTransactionConnection()) {
        RequestContextService.setTransactionConnection(connection);
      }

      try {
        const result = await handler();
        this.logger.debug(
          `[${RequestContextService.getRequestId()}] transaction committed`,
        );
        return result;
      } catch (e) {
        this.logger.debug(
          `[${RequestContextService.getRequestId()}] transaction aborted`,
        );
        throw e;
      } finally {
        RequestContextService.cleanTransactionConnection();
      }
    });
  }

  /**
   * Get database pool.
   * If global request transaction is started,
   * returns a transaction pool.
   */
  protected get pool(): DatabasePool | DatabaseTransactionConnection {
    return (
      RequestContextService.getContext().transactionConnection ?? this._pool
    );
  }
}
