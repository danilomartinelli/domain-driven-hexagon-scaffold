/** Listed profile fields; reads never reconstruct the User aggregate. */
export interface UserSummary {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly email: string;
  readonly country: string;
  readonly postalCode: string;
  readonly street: string;
}

/** An absent filter matches every profile; a present one matches exactly. */
export interface FindUsersCriteria {
  readonly country?: string;
  readonly postalCode?: string;
  readonly street?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface UserReadPort {
  /** Skip `offset` matches and return at most `limit`, in unspecified order. */
  findUsers(criteria: FindUsersCriteria): Promise<readonly UserSummary[]>;
}
