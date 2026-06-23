import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiGet, apiPost, apiPut } from "./api.js";

const paginationSchema = {
  limit: z.number().int().positive().optional().describe("Page size (default: 20)"),
  offset: z.number().int().min(0).optional().describe("Page offset (default: 0)"),
};

const couponIdSchema = {
  id: z.union([z.string(), z.number()]).describe("Coupon ID"),
};

const couponBodySchema = {
  name: z.string().describe("Coupon name"),
  currency_id: z.number().int().describe("Currency ID"),
  value: z.number().describe("Coupon value/points"),
  code_source: z
    .enum(["generate", "import"])
    .optional()
    .describe("How coupon codes are created (create only)"),
  code_quantity: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Number of codes to generate"),
  random_range: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Random part length for generated codes"),
  prefix_code: z.string().optional().describe("Generated code prefix"),
  suffix_code: z.string().optional().describe("Generated code suffix"),
  start_time: z
    .string()
    .optional()
    .describe("Start datetime (YYYY-MM-DD HH:MM:SS)"),
  end_time: z
    .string()
    .optional()
    .describe("End datetime (YYYY-MM-DD HH:MM:SS)"),
  code_expiry_interval: z
    .number()
    .int()
    .optional()
    .describe("Code expiry interval in days"),
  term_and_condition: z.string().optional().describe("Terms and conditions"),
  is_show_in_ui: z.boolean().optional().describe("Show coupon in UI"),
  max_redeem_per_user: z
    .number()
    .int()
    .optional()
    .describe("Max redemptions per user"),
  image_base64: z.string().optional().describe("Coupon image as base64"),
  import_file: z
    .string()
    .optional()
    .describe("Base64-encoded CSV import file (when code_source is import)"),
  import_filename: z
    .string()
    .optional()
    .describe("Import filename (when code_source is import)"),
};

function pickDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

export function registerTools(server: McpServer, apiKey: string) {
  const get = (path: string, query?: Record<string, string | number | undefined>) =>
    apiGet(path, query, apiKey);
  const post = (path: string, body: unknown) => apiPost(path, body, apiKey);
  const put = (path: string, body: unknown) => apiPut(path, body, apiKey);

  server.registerTool(
    "portal_me",
    { description: "Get current portal user info" },
    async () => get("/portal/me"),
  );

  server.registerTool(
    "list_teams",
    {
      description: "List portal teams",
      inputSchema: {
        ...paginationSchema,
        search: z.string().optional().describe("Search keyword"),
      },
    },
    async ({ limit, offset, search }) =>
      get("/portal/team", { limit, offset, search }),
  );

  server.registerTool(
    "list_members",
    {
      description: "List portal members/users",
      inputSchema: {
        ...paginationSchema,
        search: z.string().optional().describe("Search keyword"),
      },
    },
    async ({ limit, offset, search }) =>
      get("/portal/users", { limit, offset, search }),
  );

  server.registerTool(
    "get_member_by_id",
    {
      description: "Get a portal member/user by ID",
      inputSchema: {
        id: z.union([z.string(), z.number()]).describe("Member ID"),
      },
    },
    async ({ id }) => get(`/portal/users/${id}`),
  );

  server.registerTool(
    "list_user_coupons",
    {
      description: "List coupons for a portal member/user",
      inputSchema: {
        id: z.union([z.string(), z.number()]).describe("Member/user ID"),
        ...paginationSchema,
      },
    },
    async ({ id, limit, offset }) =>
      get(`/portal/users/${id}/coupons`, { limit, offset }),
  );

  server.registerTool(
    "list_redeem_qr_codes",
    {
      description: "List redeem QR codes",
      inputSchema: paginationSchema,
    },
    async ({ limit, offset }) =>
      get("/portal/redeem-qrcodes", { limit, offset }),
  );

  server.registerTool(
    "get_redeem_qr_code_by_id",
    {
      description: "Get a redeem QR code by ID",
      inputSchema: {
        id: z.union([z.string(), z.number()]).describe("Redeem QR code ID"),
      },
    },
    async ({ id }) => get(`/portal/redeem-qrcodes/${id}`),
  );

  server.registerTool(
    "list_coupons",
    { description: "List all coupons" },
    async () => get("/portal/coupons"),
  );

  server.registerTool(
    "get_coupon_by_id",
    {
      description: "Get a coupon by ID",
      inputSchema: couponIdSchema,
    },
    async ({ id }) => get(`/portal/coupons/${id}`),
  );

  server.registerTool(
    "create_coupon",
    {
      description: "Create a new coupon",
      inputSchema: couponBodySchema,
    },
    async (input) => post("/portal/coupons", pickDefined(input)),
  );

  server.registerTool(
    "update_coupon",
    {
      description: "Update an existing coupon by ID",
      inputSchema: {
        ...couponIdSchema,
        ...couponBodySchema,
      },
    },
    async ({ id, ...input }) =>
      put(`/portal/coupons/${id}`, pickDefined(input)),
  );

  server.registerTool(
    "list_coupon_redemptions",
    {
      description: "List redemptions for a coupon",
      inputSchema: {
        ...couponIdSchema,
        ...paginationSchema,
      },
    },
    async ({ id, limit, offset }) =>
      get(`/portal/coupons/${id}/redemptions`, { limit, offset }),
  );

  server.registerTool(
    "add_coupon_codes_generate",
    {
      description: "Add auto-generated codes to an existing coupon",
      inputSchema: {
        ...couponIdSchema,
        code_quantity: z
          .number()
          .int()
          .positive()
          .describe("Number of codes to generate"),
        random_range: z
          .number()
          .int()
          .positive()
          .describe("Random part length for generated codes"),
        prefix_code: z.string().optional().describe("Generated code prefix"),
        suffix_code: z.string().optional().describe("Generated code suffix"),
      },
    },
    async ({ id, code_quantity, random_range, prefix_code, suffix_code }) =>
      post(`/portal/coupons/${id}/codes`, {
        add_source: "generate",
        code_quantity,
        random_range,
        ...pickDefined({ prefix_code, suffix_code }),
      }),
  );

  server.registerTool(
    "add_coupon_codes_import",
    {
      description: "Import coupon codes from a base64-encoded CSV file",
      inputSchema: {
        ...couponIdSchema,
        import_file: z
          .string()
          .describe("Base64-encoded CSV file contents"),
        import_filename: z
          .string()
          .describe("Import filename (e.g. coupon_code_import_template.csv)"),
      },
    },
    async ({ id, import_file, import_filename }) =>
      post(`/portal/coupons/${id}/codes`, {
        add_source: "import",
        import_file,
        import_filename,
      }),
  );

  server.registerTool(
    "export_coupon_codes",
    {
      description: "Export coupon codes for a coupon",
      inputSchema: couponIdSchema,
    },
    async ({ id }) => get(`/portal/coupons/${id}/codes/export`),
  );

  server.registerTool(
    "list_currencies",
    { description: "List currencies" },
    async () => get("/portal/currencies"),
  );

  server.registerTool(
    "list_tiers",
    { description: "List loyalty tiers" },
    async () => get("/portal/tiers"),
  );

  server.registerTool(
    "get_tier_by_id",
    {
      description: "Get a tier by ID",
      inputSchema: {
        id: z.union([z.string(), z.number()]).describe("Tier ID"),
      },
    },
    async ({ id }) => get(`/portal/tiers/${id}`),
  );

  server.registerTool(
    "get_join_rewards",
    { description: "Get join rewards configuration for tiers" },
    async () => get("/portal/tiers/join-rewards"),
  );

  server.registerTool(
    "list_receipts",
    {
      description: "List receipts",
      inputSchema: {
        ...paginationSchema,
        state: z
          .enum(["pending", "approved", "rejected"])
          .optional()
          .describe("Filter by receipt state"),
      },
    },
    async ({ limit, offset, state }) =>
      get("/portal/receipts", { limit, offset, state }),
  );

  server.registerTool(
    "get_receipt_by_id",
    {
      description: "Get receipt detail by ID",
      inputSchema: {
        id: z.union([z.string(), z.number()]).describe("Receipt ID"),
      },
    },
    async ({ id }) => get(`/portal/receipts/${id}`),
  );

  server.registerTool(
    "get_dashboard",
    {
      description: "Get portal dashboard analytics",
      inputSchema: {
        date_from: z.string().describe("Start date (YYYY-MM-DD)"),
        date_to: z.string().describe("End date (YYYY-MM-DD)"),
        granularity: z
          .enum(["day", "week", "month"])
          .optional()
          .describe("Time granularity (default: day)"),
      },
    },
    async ({ date_from, date_to, granularity }) =>
      get("/portal/dashboard", { date_from, date_to, granularity }),
  );
}
