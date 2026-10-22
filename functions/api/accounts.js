export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method;

  try {
    // 1. Lấy danh sách tài khoản
    if (method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT id, name, secret FROM accounts ORDER BY id DESC'
      ).all();
      return Response.json(results);
    }

    // 2. Thêm tài khoản mới
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

    // 3. Xóa tài khoản
    if (method === 'DELETE') {
      const url = new URL(request.url);
      const id = url.searchParams.get('id');
      await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
      return Response.json({ success: true });
    }

    return new Response('Method Not Allowed', { status: 405 });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
