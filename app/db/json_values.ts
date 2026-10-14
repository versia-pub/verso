import {
  type KyselyPlugin,
  OperationNodeTransformer,
  type PrimitiveValueListNode,
  type ValueNode,
} from "kysely";

const isJson = (value: unknown): boolean =>
  Array.isArray(value) ||
  (typeof value === "object" && value !== null &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)));

const toJson = (value: unknown): unknown =>
  isJson(value) ? JSON.stringify(value) : value;

class JsonTransformer extends OperationNodeTransformer {
  protected override transformValue(node: ValueNode): ValueNode {
    return { ...super.transformValue(node), value: toJson(node.value) };
  }

  protected override transformPrimitiveValueList(
    node: PrimitiveValueListNode,
  ): PrimitiveValueListNode {
    return { ...node, values: node.values.map(toJson) };
  }
}

/**
 * Sends plain objects and arrays to the database as JSON text, for the JSON column helper. Left
 * alone, `pg` would send arrays as Postgres arrays and SQLite would refuse both.
 *
 * So a query can't take an array as one parameter, as in `= any(${ids})`; use `in` instead.
 */
export const jsonValues: KyselyPlugin = {
  transformQuery: ({ node, queryId }) =>
    new JsonTransformer().transformNode(node, queryId),
  transformResult: ({ result }) => Promise.resolve(result),
};
