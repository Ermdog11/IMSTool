// Shared Bluesky (AT Protocol) auth + API helpers. Used by:
//   - api/bluesky.js: read-only search of OTHER people's posts (Hot Social feed)
//   - api/social-promo-check.js: write access to OUR OWN account (the promo bot)
//
// Env vars (Vercel):
//   BSKY_IDENTIFIER   - the account handle/email used to log in
//   BSKY_APP_PASSWORD - an app password (Bluesky Settings -> App Passwords),
//                       never the real account password

var BASE = 'https://bsky.social/xrpc';

function isConfigured() {
  return !!(process.env.BSKY_IDENTIFIER && process.env.BSKY_APP_PASSWORD);
}

async function createSession() {
  var r = await fetch(BASE + '/com.atproto.server.createSession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: process.env.BSKY_IDENTIFIER, password: process.env.BSKY_APP_PASSWORD })
  });
  if (!r.ok) throw new Error('Bluesky login failed (' + r.status + '): ' + (await r.text()).slice(0, 150));
  var session = await r.json();
  return { token: session.accessJwt, did: session.did, handle: session.handle };
}

// Our own recent ORIGINAL posts (posts_no_replies excludes anything that's
// itself a reply), each already carrying live engagement counts — no
// separate "check this post's stats" call needed.
async function getOwnPosts(token, did, limit) {
  var url = BASE + '/app.bsky.feed.getAuthorFeed?actor=' + encodeURIComponent(did) +
    '&limit=' + (limit || 30) + '&filter=posts_no_replies';
  var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
  if (!r.ok) throw new Error('Bluesky getAuthorFeed failed (' + r.status + '): ' + (await r.text()).slice(0, 150));
  var data = await r.json();
  return (data.feed || []).map(function(item) {
    var post = item.post || {};
    return {
      uri: post.uri,
      cid: post.cid,
      text: (post.record && post.record.text) || '',
      createdAt: post.record && post.record.createdAt,
      likeCount: post.likeCount || 0,
      repostCount: post.repostCount || 0,
      replyCount: post.replyCount || 0
    };
  });
}

// A direct (non-threaded) reply: root and parent are the same post.
async function replyToPost(token, did, parent, text) {
  var r = await fetch(BASE + '/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({
      repo: did,
      collection: 'app.bsky.feed.post',
      record: {
        '$type': 'app.bsky.feed.post',
        text: text,
        createdAt: new Date().toISOString(),
        reply: {
          root: { uri: parent.uri, cid: parent.cid },
          parent: { uri: parent.uri, cid: parent.cid }
        }
      }
    })
  });
  if (!r.ok) throw new Error('Bluesky reply failed (' + r.status + '): ' + (await r.text()).slice(0, 200));
  return r.json();
}

module.exports = {
  isConfigured: isConfigured,
  createSession: createSession,
  getOwnPosts: getOwnPosts,
  replyToPost: replyToPost
};
