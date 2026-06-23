import { z } from "zod";
import { apiGet } from "./api.js";
const paginationSchema = {
    limit: z.number().int().positive().optional().describe("Page size (default: 20)"),
    offset: z.number().int().min(0).optional().describe("Page offset (default: 0)"),
};
export function registerTools(server, apiKey) {
    const get = (path, query) => apiGet(path, query, apiKey);
    server.registerTool("portal_me", { description: "Get current portal user info" }, async () => get("/portal/me"));
    server.registerTool("list_teams", {
        description: "List portal teams",
        inputSchema: {
            ...paginationSchema,
            search: z.string().optional().describe("Search keyword"),
        },
    }, async ({ limit, offset, search }) => get("/portal/team", { limit, offset, search }));
    server.registerTool("list_members", {
        description: "List portal members/users",
        inputSchema: {
            ...paginationSchema,
            search: z.string().optional().describe("Search keyword"),
        },
    }, async ({ limit, offset, search }) => get("/portal/users", { limit, offset, search }));
    server.registerTool("get_member_by_id", {
        description: "Get a portal member/user by ID",
        inputSchema: {
            id: z.union([z.string(), z.number()]).describe("Member ID"),
        },
    }, async ({ id }) => get(`/portal/users/${id}`));
    server.registerTool("list_user_coupons", {
        description: "List coupons for a portal member/user",
        inputSchema: {
            id: z.union([z.string(), z.number()]).describe("Member/user ID"),
            ...paginationSchema,
        },
    }, async ({ id, limit, offset }) => get(`/portal/users/${id}/coupons`, { limit, offset }));
    server.registerTool("list_redeem_qr_codes", {
        description: "List redeem QR codes",
        inputSchema: paginationSchema,
    }, async ({ limit, offset }) => get("/portal/redeem-qrcodes", { limit, offset }));
    server.registerTool("get_redeem_qr_code_by_id", {
        description: "Get a redeem QR code by ID",
        inputSchema: {
            id: z.union([z.string(), z.number()]).describe("Redeem QR code ID"),
        },
    }, async ({ id }) => get(`/portal/redeem-qrcodes/${id}`));
    server.registerTool("list_coupons", { description: "List all coupons" }, async () => get("/portal/coupons"));
    server.registerTool("get_coupon_by_id", {
        description: "Get a coupon by ID",
        inputSchema: {
            id: z.union([z.string(), z.number()]).describe("Coupon ID"),
        },
    }, async ({ id }) => get(`/portal/coupons/${id}`));
    server.registerTool("list_coupon_redemptions", {
        description: "List redemptions for a coupon",
        inputSchema: {
            id: z.union([z.string(), z.number()]).describe("Coupon ID"),
            ...paginationSchema,
        },
    }, async ({ id, limit, offset }) => get(`/portal/coupons/${id}/redemptions`, { limit, offset }));
    server.registerTool("export_coupon_codes", {
        description: "Export coupon codes for a coupon",
        inputSchema: {
            id: z.union([z.string(), z.number()]).describe("Coupon ID"),
        },
    }, async ({ id }) => get(`/portal/coupons/${id}/codes/export`));
    server.registerTool("list_currencies", { description: "List currencies" }, async () => get("/portal/currencies"));
    server.registerTool("list_tiers", { description: "List loyalty tiers" }, async () => get("/portal/tiers"));
    server.registerTool("get_tier_by_id", {
        description: "Get a tier by ID",
        inputSchema: {
            id: z.union([z.string(), z.number()]).describe("Tier ID"),
        },
    }, async ({ id }) => get(`/portal/tiers/${id}`));
    server.registerTool("get_join_rewards", { description: "Get join rewards configuration for tiers" }, async () => get("/portal/tiers/join-rewards"));
    server.registerTool("list_receipts", {
        description: "List receipts",
        inputSchema: {
            ...paginationSchema,
            state: z
                .enum(["pending", "approved", "rejected"])
                .optional()
                .describe("Filter by receipt state"),
        },
    }, async ({ limit, offset, state }) => get("/portal/receipts", { limit, offset, state }));
    server.registerTool("get_receipt_by_id", {
        description: "Get receipt detail by ID",
        inputSchema: {
            id: z.union([z.string(), z.number()]).describe("Receipt ID"),
        },
    }, async ({ id }) => get(`/portal/receipts/${id}`));
    server.registerTool("get_dashboard", {
        description: "Get portal dashboard analytics",
        inputSchema: {
            date_from: z.string().describe("Start date (YYYY-MM-DD)"),
            date_to: z.string().describe("End date (YYYY-MM-DD)"),
            granularity: z
                .enum(["day", "week", "month"])
                .optional()
                .describe("Time granularity (default: day)"),
        },
    }, async ({ date_from, date_to, granularity }) => get("/portal/dashboard", { date_from, date_to, granularity }));
}
