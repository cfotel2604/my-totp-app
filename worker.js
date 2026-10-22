export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Xử lý API đồng bộ D1 tại đường dẫn /api/accounts
    if (url.pathname === '/api/accounts') {
      const method = request.method;
      try {
        if (method === 'GET') {
          const { results } = await env.DB.prepare(
            'SELECT id, name, secret FROM accounts ORDER BY id DESC'
          ).all();
          return Response.json(results);
        }

        if (method === 'POST') {
          const { name, secret } = await request.json();
          if (!name || !secret) {
            return Response.json({ error: 'Thiếu thông tin' }, { status: 400 });
          }
          await env.DB.prepare(
            'INSERT INTO accounts (name, secret) VALUES (?, ?)'
          ).bind(name, secret).run();
          return Response.json({ success: true });
        }

        if (method === 'DELETE') {
          const id = url.searchParams.get('id');
          await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
          return Response.json({ success: true });
        }

        return new Response('Method Not Allowed', { status: 405 });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // Các đường dẫn khác thì trả về giao diện tĩnh (index.html)
    return env.ASSETS.fetch(request);
  }
};
