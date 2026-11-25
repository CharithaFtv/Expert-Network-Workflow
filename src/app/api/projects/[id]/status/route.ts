import { changeProjectStatus } from "@/lib/projectStatus";
import { currentUser } from "@/lib/session";

const HTTP = { not_found: 404, forbidden: 403, invalid: 422, not_allowed: 409 } as const;

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "Project not found." }, { status: 404 });
  let body: { status?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Malformed request." }, { status: 400 });
  }
  const result = await changeProjectStatus(Number(id), user, body.status);
  if (!result.ok) return Response.json({ error: result.error }, { status: HTTP[result.code] });
  return Response.json({ status: result.status });
}
