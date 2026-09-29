import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { allowOrigins, handleArena } from "../../../functions/handler.mjs";

// Fallbacks keep deploys working before any secret is configured; CORS_ORIGINS
// (comma separated) extends the list per environment.
allowOrigins(
  "https://newyunming.github.io",
  "https://baihua-quest-i50diaxrw5z.qoder.zone",
  ...(Deno.env.get("CORS_ORIGINS") || "").split(",").map((origin) => origin.trim()).filter(Boolean),
);

function withCors(request: Request, headers: Headers) {
  headers.set("access-control-allow-origin", request.headers.get("origin") || "*");
  headers.set("vary", "origin");
  return headers;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: withCors(request, new Headers({
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      })),
    });
  }
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
  const response = await handleArena({ request, supabase });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: withCors(request, new Headers(response.headers)),
  });
});
