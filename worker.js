/**
 * Cloudflare Worker - Cloud TOTP Authenticator API (D1 Database)
 * Hỗ trợ đầy đủ:
 * - Tự động khởi tạo & nâng cấp bảng D1 (Auto-migration tương thích ngược với bảng cũ)
 * - Lưu trữ: id, name, secret, provider, pinned, sort_order, digits, period, algorithm, updated_at
 * - GET /api/accounts: Lấy danh sách tài khoản (ưu tiên ghim -> thứ tự sắp xếp -> mới nhất)
 * - POST /api/accounts: Thêm 1 hoặc nhiều tài khoản (Batch import)
 * - PUT /api/accounts: Cập nhật thông tin tài khoản (Ghim/bỏ ghim, đổi tên, đổi provider, sắp xếp)
 * - DELETE /api/accounts?id=...: Xoá tài khoản
 */

let schemaInitialized = false;

async function ensureSchema(db) {
  if (schemaInitialized || !db) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        secret TEXT NOT NULL,
        provider TEXT DEFAULT '',
        pinned INTEGER DEFAULT 0,
        sort_order INTEGER DEFAULT 0,
        digits INTEGER DEFAULT 6,
        period INTEGER DEFAULT 30,
        algorithm TEXT DEFAULT 'SHA-1',
        updated_at INTEGER DEFAULT 0
      )
    `).run();

    // Tự động thêm các cột mới nếu bảng accounts cũ chỉ có (id, name, secret)
    const migrations = [
      "ALTER TABLE accounts ADD COLUMN provider TEXT DEFAULT ''",
      "ALTER TABLE accounts ADD COLUMN pinned INTEGER DEFAULT 0",
      "ALTER TABLE accounts ADD COLUMN sort_order INTEGER DEFAULT 0",
      "ALTER TABLE accounts ADD COLUMN digits INTEGER DEFAULT 6",
      "ALTER TABLE accounts ADD COLUMN period INTEGER DEFAULT 30",
      "ALTER TABLE accounts ADD COLUMN algorithm TEXT DEFAULT 'SHA-1'",
      "ALTER TABLE accounts ADD COLUMN updated_at INTEGER DEFAULT 0"
    ];

    for (const sql of migrations) {
      try {
        await db.prepare(sql).run();
      } catch (_) {
        // Cột đã tồn tại -> bỏ qua
      }
    }
    schemaInitialized = true;
  } catch (_) {
    // Nếu D1 không cho phép DDL tự động thì vẫn fallback về bảng cũ
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Xử lý CORS nếu gọi API từ môi trường dev
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Xử lý API đồng bộ D1 tại đường dẫn /api/accounts
    if (url.pathname === '/api/accounts') {
      const method = request.method;

      if (!env || !env.DB) {
        return Response.json(
          { error: 'Chưa cấu hình D1 Database Binding (env.DB)' },
          { status: 500, headers: corsHeaders }
        );
      }

      await ensureSchema(env.DB);

      try {
        // 1. Lấy danh sách tài khoản
        if (method === 'GET') {
          try {
            const { results } = await env.DB.prepare(
              `SELECT id, name, secret, provider, pinned, sort_order, digits, period, algorithm, updated_at
               FROM accounts
               ORDER BY pinned DESC, sort_order ASC, id DESC`
            ).all();
            return Response.json(results, { headers: corsHeaders });
          } catch (_) {
            // Fallback tương thích 100% với bảng cũ chỉ có 3 cột (id, name, secret)
            const { results } = await env.DB.prepare(
              'SELECT id, name, secret FROM accounts ORDER BY id DESC'
            ).all();
            return Response.json(results, { headers: corsHeaders });
          }
        }

        // 2. Thêm mới 1 tài khoản hoặc nhập hàng loạt (batch)
        if (method === 'POST') {
          const body = await request.json();
          const items = Array.isArray(body.accounts) ? body.accounts : [body];
          const insertedIds = [];

          for (const item of items) {
            const name = (item.name || '').trim();
            const secret = (item.secret || '').replace(/\s+/g, '').toUpperCase();
            const provider = (item.provider || '').trim();
            const pinned = item.pinned ? 1 : 0;
            const sortOrder = Number(item.sort_order) || 0;
            const digits = Number(item.digits) === 8 ? 8 : 6;
            const period = Number(item.period) === 60 ? 60 : 30;
            const algorithm = ['SHA-1', 'SHA-256', 'SHA-512'].includes(item.algorithm)
              ? item.algorithm
              : 'SHA-1';
            const updatedAt = Date.now();

            if (!name || !secret) {
              if (items.length === 1) {
                return Response.json(
                  { error: 'Thiếu tên tài khoản hoặc Secret Key' },
                  { status: 400, headers: corsHeaders }
                );
              }
              continue;
            }

            try {
              const res = await env.DB.prepare(
                `INSERT INTO accounts (name, secret, provider, pinned, sort_order, digits, period, algorithm, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
              )
                .bind(name, secret, provider, pinned, sortOrder, digits, period, algorithm, updatedAt)
                .run();
              insertedIds.push(res?.meta?.last_row_id || null);
            } catch (_) {
              // Fallback cho bảng cũ chỉ có (name, secret)
              const res = await env.DB.prepare(
                'INSERT INTO accounts (name, secret) VALUES (?, ?)'
              )
                .bind(name, secret)
                .run();
              insertedIds.push(res?.meta?.last_row_id || null);
            }
          }

          return Response.json(
            { success: true, ids: insertedIds, id: insertedIds[0] || null },
            { headers: corsHeaders }
          );
        }

        // 3. Cập nhật tài khoản (Ghim, sửa tên, đổi provider, sắp xếp)
        if (method === 'PUT') {
          const body = await request.json();
          const id = body.id || url.searchParams.get('id');
          if (!id) {
            return Response.json(
              { error: 'Thiếu ID tài khoản cần cập nhật' },
              { status: 400, headers: corsHeaders }
            );
          }

          const name = (body.name || '').trim();
          const provider = (body.provider || '').trim();
          const pinned = body.pinned ? 1 : 0;
          const sortOrder = Number(body.sort_order) || 0;
          const digits = Number(body.digits) === 8 ? 8 : 6;
          const period = Number(body.period) === 60 ? 60 : 30;
          const algorithm = ['SHA-1', 'SHA-256', 'SHA-512'].includes(body.algorithm)
            ? body.algorithm
            : 'SHA-1';
          const updatedAt = Date.now();

          try {
            if (body.secret) {
              const secret = body.secret.replace(/\s+/g, '').toUpperCase();
              await env.DB.prepare(
                `UPDATE accounts
                 SET name = ?, secret = ?, provider = ?, pinned = ?, sort_order = ?, digits = ?, period = ?, algorithm = ?, updated_at = ?
                 WHERE id = ?`
              )
                .bind(name, secret, provider, pinned, sortOrder, digits, period, algorithm, updatedAt, id)
                .run();
            } else {
              await env.DB.prepare(
                `UPDATE accounts
                 SET name = COALESCE(NULLIF(?, ''), name),
                     provider = ?,
                     pinned = ?,
                     sort_order = ?,
                     digits = ?,
                     period = ?,
                     algorithm = ?,
                     updated_at = ?
                 WHERE id = ?`
              )
                .bind(name, provider, pinned, sortOrder, digits, period, algorithm, updatedAt, id)
                .run();
            }
          } catch (_) {
            // Fallback nếu bảng cũ chỉ có cột name
            if (name) {
              await env.DB.prepare('UPDATE accounts SET name = ? WHERE id = ?')
                .bind(name, id)
                .run();
            }
          }

          return Response.json({ success: true }, { headers: corsHeaders });
        }

        // 4. Xoá tài khoản
        if (method === 'DELETE') {
          const id = url.searchParams.get('id');
          if (!id) {
            return Response.json(
              { error: 'Thiếu ID cần xoá' },
              { status: 400, headers: corsHeaders }
            );
          }
          await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
          return Response.json({ success: true }, { headers: corsHeaders });
        }

        return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
      } catch (err) {
        return Response.json(
          { error: err.message },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // Các đường dẫn khác thì trả về giao diện tĩnh (index.html)
    return env.ASSETS.fetch(request);
  }
};
