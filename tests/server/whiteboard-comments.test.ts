import { afterAll, beforeAll, beforeEach, describe, it } from "bun:test";
import { assert } from "chai";
import type { Claims } from "lib/access";
import { Random } from "lib/compat/random";
import BoardComments from "lib/models/BoardComments";
import WhiteboardNodes from "lib/models/WhiteboardNodes";
import type { WhiteboardNodeInput } from "lib/protocol";
import type { Change } from "../../server/changes";
import { onChange } from "../../server/changes";
import {
  deleteComment,
  editComment,
  postComment,
  react,
  setCommentResolved,
} from "../../server/comments";
import { ensureBoard } from "../../server/whiteboard";
import { deleteNodes, upsertNodes } from "../../server/whiteboardEdits";
import {
  archived,
  call,
  claimsFor,
  clearFlag,
  huntId,
  makeFixtureHunt,
  makeUser,
  rejects,
  resetDatabase,
  setFlag,
  setUpDatabase,
  tearDownDatabase,
} from "./harness";

describe("whiteboard comments", () => {
  let operator: Claims;
  let member: Claims;
  let outsider: Claims;
  let boardId: string;

  beforeAll(setUpDatabase);
  afterAll(tearDownDatabase);

  beforeEach(async () => {
    await resetDatabase();
    operator = makeUser(true);
    member = makeUser();
    outsider = { ...makeUser(), scope: { hunt: Random.id() } };
    await makeFixtureHunt(operator.user);
    boardId = await ensureBoard({ hunt: huntId }, operator.user);
  });

  const node = (id: string) => WhiteboardNodes.findOneAsync(id);
  const addSticky = async (
    claims: Claims,
    position: { x: number; y: number },
    extra: Partial<WhiteboardNodeInput> = {},
  ) => {
    const _id = Random.id();
    await upsertNodes(claims, boardId, [
      { _id, type: "sticky", position, ...extra },
    ]);
    return _id;
  };
  // Sends a comment on the board and returns it
  const sendComment = async (
    claims: Claims,
    text: string,
    rest: {
      parentId?: string;
      anchor?: { node?: string; x: number; y: number };
    },
  ) => {
    const id = await postComment(claims, boardId, { text, ...rest });
    return (await BoardComments.findOneAsync(id))!;
  };
  const reply = (claims: Claims, parentId: string, text: string) =>
    sendComment(claims, text, { parentId });
  const reaction = async (claims: Claims, messageId: string, emoji: string) => {
    const id = (await react(claims, boardId, messageId, emoji, true))!;
    return (await BoardComments.findOneAsync(id))!;
  };
  const reload = async (id: string) =>
    (await BoardComments.findOneAllowingDeletedAsync(id))!;
  const setResolved = (claims: Claims, messageId: string, resolved: boolean) =>
    call("comment.resolve", claims, boardId, { messageId, resolved });
  const remove = (claims: Claims, messageId: string) =>
    call("comment.delete", claims, boardId, { messageId });

  it("pins a comment to a node or loose on the board", async () => {
    const node = await addSticky(member, { x: 100, y: 100 });
    const pinned = await sendComment(member, "on the sticky", {
      anchor: { node, x: 5, y: 6 },
    });
    assert.deepEqual(pinned.comment, { node, x: 5, y: 6 });
    assert.notOk(pinned.thread);
    assert.equal(pinned.sender, member.user);
    assert.equal(pinned.board, boardId);
    assert.equal(pinned.hunt, huntId);
    assert.deepEqual(pinned.content, {
      type: "message",
      children: [{ text: "on the sticky" }],
    });

    const loose = await sendComment(member, "on the board", {
      anchor: { x: -50, y: 70 },
    });
    assert.deepEqual(loose.comment, { x: -50, y: 70 });
  });

  it("needs a pin or a parent, and something to say", async () => {
    await rejects(
      postComment(member, boardId, { text: "nowhere" }),
      /needs a pin or a parent/,
    );
    await rejects(
      postComment(member, boardId, { text: "   ", anchor: { x: 0, y: 0 } }),
      /can't be empty/,
    );
    assert.equal(await BoardComments.find({ board: boardId }).countAsync(), 0);
  });

  it("rejects comments from outside the hunt, in an archived hunt or with the whiteboard off", async () => {
    const anchor = { x: 0, y: 0 };
    await rejects(sendComment(outsider, "outsider", { anchor }), /member/);

    await setFlag("disable.whiteboard");
    await rejects(sendComment(member, "flag", { anchor }), /disabled/);
    await clearFlag("disable.whiteboard");

    await rejects(
      sendComment(archived(member), "archived", { anchor }),
      /archived/,
    );
    assert.equal(await BoardComments.find({ board: boardId }).countAsync(), 0);
  });

  it("only pins to visible nodes on this board that can take a comment", async () => {
    const elsewhere = await WhiteboardNodes.insertAsync({
      hunt: huntId,
      board: Random.id(),
      type: "sticky",
      position: { x: 0, y: 0 },
      createdBy: member.user,
    });
    const card = (await WhiteboardNodes.findOneAsync({
      board: boardId,
      type: "puzzle",
    }))!;
    await deleteNodes(member, boardId, [card._id]);
    const ink = Random.id();
    await upsertNodes(member, boardId, [
      {
        _id: ink,
        type: "ink",
        position: { x: 0, y: 0 },
        strokeWidth: "thin",
        points: [
          [0, 0, 0.5],
          [1, 1, 0.5],
        ],
      },
    ]);

    for (const node of [elsewhere, card._id, ink, Random.id()]) {
      await rejects(
        sendComment(member, `on ${node}`, { anchor: { node, x: 0, y: 0 } }),
        /pinned there/,
      );
    }
    await rejects(
      sendComment(member, "far away", { anchor: { x: 2e6, y: 0 } }),
      /out of range/,
    );
  });

  it("won't start a thread on a reply", async () => {
    const root = await sendComment(member, "root", { anchor: { x: 0, y: 0 } });
    await rejects(
      sendComment(member, "both", {
        parentId: root._id,
        anchor: { x: 10, y: 10 },
      }),
      /reply/,
    );
  });

  it("won't take a reply to a deleted comment", async () => {
    const root = await sendComment(member, "root", { anchor: { x: 0, y: 0 } });
    await remove(member, root._id);
    await rejects(reply(member, root._id, "too late"), /not on board/);
  });

  it("stamps every reply in a thread with its root", async () => {
    const root = await sendComment(member, "root", { anchor: { x: 0, y: 0 } });
    const first = await reply(operator, root._id, "first");
    const nested = await reply(member, first._id, "nested");
    const thumbs = await reaction(operator, nested._id, "👍");
    assert.equal(first.thread, root._id);
    assert.equal(nested.thread, root._id);
    assert.equal(thumbs.thread, root._id);
    assert.equal(thumbs.parentId, nested._id);
  });

  it("reopens a resolved thread on a reply but not a reaction", async () => {
    const node = await addSticky(member, { x: 0, y: 0 });
    const root = await sendComment(member, "root", {
      anchor: { node, x: 1, y: 2 },
    });

    await setResolved(operator, root._id, true);
    let saved = await reload(root._id);
    assert.ok(saved.comment?.resolvedAt);
    assert.equal(saved.comment?.resolvedBy, operator.user);
    assert.equal(saved.comment?.node, node);
    assert.equal(saved.comment?.x, 1);
    assert.equal(saved.comment?.y, 2);

    // Resolving again keeps the first resolution
    const firstResolvedAt = saved.comment?.resolvedAt;
    await setResolved(member, root._id, true);
    saved = await reload(root._id);
    assert.equal(saved.comment?.resolvedBy, operator.user);
    assert.deepEqual(saved.comment?.resolvedAt, firstResolvedAt);

    await reaction(member, root._id, "🎉");
    assert.ok((await reload(root._id)).comment?.resolvedAt);

    await reply(member, root._id, "actually, not done");
    saved = await reload(root._id);
    assert.notOk(saved.comment?.resolvedAt);
    assert.notOk(saved.comment?.resolvedBy);

    await setResolved(member, root._id, true);
    await setResolved(member, root._id, false);
    assert.notOk((await reload(root._id)).comment?.resolvedAt);
  });

  it("won't take a reply in a thread on a board that can't be written", async () => {
    const root = await sendComment(member, "root", { anchor: { x: 0, y: 0 } });
    const first = await reply(operator, root._id, "first reply");
    await setResolved(member, root._id, true);

    await rejects(reply(archived(member), root._id, "reopen"), /archived/);
    await rejects(reply(archived(member), first._id, "deeper"), /archived/);
    await rejects(reaction(archived(member), root._id, "👍"), /archived/);

    await setFlag("disable.whiteboard");
    await rejects(reply(member, root._id, "flag"), /disabled/);

    assert.ok((await reload(root._id)).comment?.resolvedAt);
    assert.equal(
      await BoardComments.find({ thread: root._id }).countAsync(),
      1,
    );
  });

  it("only resolves root comments, for anyone in the hunt", async () => {
    const root = await sendComment(member, "root", { anchor: { x: 0, y: 0 } });
    const replyMessage = await reply(operator, root._id, "a reply");

    await rejects(setResolved(outsider, root._id, true), /member/);
    await rejects(
      setResolved(member, replyMessage._id, true),
      /Unknown comment/,
    );
    await rejects(setResolved(member, Random.id(), true), /Unknown comment/);
    await rejects(setResolved(archived(member), root._id, true), /archived/);
    assert.notOk((await reload(root._id)).comment?.resolvedAt);
  });

  it("lets the author delete a comment until someone else replies", async () => {
    const other = makeUser();
    const root = await sendComment(member, "root", { anchor: { x: 0, y: 0 } });
    // Reactions and the author's own replies don't count.
    await reaction(other, root._id, "👀");
    const own = await reply(member, root._id, "and another thing");

    await rejects(remove(other, root._id), /author/);
    await rejects(remove(outsider, root._id), /member/);
    await remove(member, root._id);
    assert.isTrue((await reload(root._id)).deleted);
    assert.isTrue((await reload(own._id)).deleted);
    assert.equal(
      await BoardComments.find({ thread: root._id }).countAsync(),
      0,
    );

    const second = await sendComment(member, "second", {
      anchor: { x: 0, y: 0 },
    });
    await reply(other, second._id, "a real reply");
    await rejects(remove(member, second._id), /operator/);
  });

  it("lets an operator delete any comment along with its thread", async () => {
    const other = makeUser();
    const root = await sendComment(member, "root", { anchor: { x: 0, y: 0 } });
    const first = await reply(other, root._id, "first");
    const nested = await reply(member, first._id, "nested");

    await deleteComment(operator, boardId, root._id);
    for (const id of [root._id, first._id, nested._id]) {
      assert.isTrue((await reload(id)).deleted);
    }
  });

  it("empties a reply in place, for its sender, and takes its reactions with it", async () => {
    const other = makeUser();
    const root = await sendComment(member, "root", { anchor: { x: 0, y: 0 } });
    const answer = await reply(other, root._id, "an answer");
    const thumbs = await reaction(member, answer._id, "👍");
    const deeper = await reply(member, answer._id, "a follow-up");

    await rejects(remove(member, answer._id), /Unknown message/);
    await rejects(remove(member, thumbs._id), /taken back, not deleted/);
    await rejects(remove(archived(other), answer._id), /archived/);
    await remove(other, answer._id);

    const emptied = await reload(answer._id);
    assert.ok(emptied.deletedAt);
    assert.deepEqual(emptied.content.children, []);
    assert.isFalse(emptied.deleted);
    assert.notOk(await BoardComments.findOneAsync(thumbs._id));
    // The follow-up keeps its place
    assert.equal((await reload(deeper._id)).parentId, answer._id);
    // Deleting again is nothing, and nobody can react to it now
    await remove(other, answer._id);
    await rejects(reaction(member, answer._id, "👍"), /has been deleted/);
    // though a reply still can
    await reply(member, answer._id, "still here");
  });

  it("lets the sender edit a comment or reply, and nobody else", async () => {
    const other = makeUser();
    const root = await sendComment(member, "root", { anchor: { x: 1, y: 2 } });
    const answer = await reply(other, root._id, "an answer");
    const thumbs = await reaction(member, root._id, "👍");
    const edit = (claims: Claims, messageId: string, text: string) =>
      call("comment.edit", claims, boardId, { messageId, text });

    await rejects(edit(other, root._id, "hijack"), /Unknown message/);
    await rejects(edit(member, root._id, "  "), /edited to nothing/);
    await rejects(edit(member, thumbs._id, "👎"), /can't be edited/);
    await rejects(edit(other, answer._id, "🎉"), /into a reaction/);
    await rejects(edit(archived(member), root._id, "later"), /archived/);

    await edit(member, root._id, "root, revised");
    const revised = await reload(root._id);
    assert.deepEqual(revised.content.children, [{ text: "root, revised" }]);
    assert.ok(revised.editedAt);
    assert.deepEqual(revised.comment, { x: 1, y: 2 });

    await editComment(other, boardId, answer._id, "an answer, revised");
    assert.deepEqual((await reload(answer._id)).content.children, [
      { text: "an answer, revised" },
    ]);
    await remove(other, answer._id);
    await rejects(edit(other, answer._id, "too late"), /has been deleted/);
  });

  it("adds a reaction once per emoji per person, and takes it back", async () => {
    const root = await sendComment(member, "root", { anchor: { x: 0, y: 0 } });
    const toggle = (claims: Claims, emoji: string, on: boolean) =>
      call("comment.react", claims, boardId, {
        messageId: root._id,
        emoji,
        on,
      });
    const reactions = () =>
      BoardComments.find({ board: boardId, parentId: root._id }).fetchAsync();

    await rejects(toggle(member, "not an emoji", true), /is an emoji/);
    await toggle(member, "👍", true);
    await toggle(member, "👍", true);
    await toggle(member, "🎉", true);
    await toggle(operator, "👍", true);
    assert.sameDeepMembers(
      (await reactions()).map((r) => [
        r.sender,
        r.content.children[0] && "text" in r.content.children[0]
          ? r.content.children[0].text
          : "",
      ]),
      [
        [member.user, "👍"],
        [member.user, "🎉"],
        [operator.user, "👍"],
      ],
    );

    await toggle(member, "👍", false);
    // Someone else's stays
    await toggle(operator, "🎉", false);
    assert.sameDeepMembers(
      (await reactions()).map((r) => r.sender),
      [member.user, operator.user],
    );
    await rejects(toggle(outsider, "👍", true), /member/);
  });

  it("leaves comments where they were when their node is deleted", async () => {
    const frame = Random.id();
    await upsertNodes(member, boardId, [
      {
        _id: frame,
        type: "frame",
        position: { x: 100, y: 200 },
        width: 500,
        height: 500,
      },
    ]);
    const nested = await addSticky(member, { x: 10, y: 20 }, { parent: frame });
    const topLevel = await addSticky(member, { x: 300, y: 400 });
    const onNested = await sendComment(member, "on nested", {
      anchor: { node: nested, x: 5, y: 6 },
    });
    const onTopLevel = await sendComment(member, "on top level", {
      anchor: { node: topLevel, x: 7, y: 8 },
    });

    await deleteNodes(member, boardId, [nested, topLevel]);
    // Each remembers its node, for a restore that brings it back
    assert.deepEqual((await reload(onNested._id)).comment, {
      x: 115,
      y: 226,
      detachedFrom: nested,
    });
    assert.deepEqual((await reload(onTopLevel._id)).comment, {
      x: 307,
      y: 408,
      detachedFrom: topLevel,
    });
  });

  it("keeps a comment on its node when only the frame around it goes", async () => {
    const frame = Random.id();
    await upsertNodes(member, boardId, [
      { _id: frame, type: "frame", position: { x: 100, y: 200 } },
    ]);
    const nested = await addSticky(member, { x: 10, y: 20 }, { parent: frame });
    const onFrame = await sendComment(member, "on frame", {
      anchor: { node: frame, x: 1, y: 1 },
    });
    const onNested = await sendComment(member, "on nested", {
      anchor: { node: nested, x: 5, y: 6 },
    });

    await deleteNodes(member, boardId, [frame]);
    assert.deepEqual((await reload(onFrame._id)).comment, {
      x: 101,
      y: 201,
      detachedFrom: frame,
    });
    assert.deepEqual((await reload(onNested._id)).comment, {
      node: nested,
      x: 5,
      y: 6,
    });
  });

  it("leaves comments where they were when a puzzle card is hidden", async () => {
    const card = (
      await WhiteboardNodes.find({
        board: boardId,
        type: "puzzle",
      }).fetchAsync()
    ).find((n) => n.parent)!;
    let at = { ...card.position };
    for (let parent = card.parent; parent; ) {
      const frame = (await node(parent))!;
      at = { x: at.x + frame.position.x, y: at.y + frame.position.y };
      parent = frame.parent;
    }
    const message = await sendComment(member, "on the card", {
      anchor: { node: card._id, x: 3, y: 4 },
    });
    await deleteNodes(member, boardId, [card._id]);
    assert.isTrue((await node(card._id))?.hidden);
    assert.deepEqual((await reload(message._id)).comment, {
      x: at.x + 3,
      y: at.y + 4,
      detachedFrom: card._id,
    });
  });

  it("keeps a comment on the edge of a node that has shrunk when it goes", async () => {
    const node = await addSticky(member, { x: 100, y: 100 });
    await upsertNodes(member, boardId, [
      { _id: node, type: "sticky", width: 200, height: 100 },
    ]);
    const message = await sendComment(member, "near the corner", {
      anchor: { node, x: 180, y: 90 },
    });
    await upsertNodes(member, boardId, [
      { _id: node, type: "sticky", width: 100, height: 50 },
    ]);
    await deleteNodes(member, boardId, [node]);
    assert.deepEqual((await reload(message._id)).comment, {
      x: 200,
      y: 150,
      detachedFrom: node,
    });
  });

  it("only takes messages on this board", async () => {
    const root = await sendComment(member, "root", { anchor: { x: 0, y: 0 } });
    const puzzle = Random.id();
    const other = await ensureBoard({ hunt: huntId, puzzle });
    const there = claimsFor(member.user, { puzzle });
    await rejects(
      setCommentResolved(there, other, root._id, true),
      /Unknown comment/,
    );
    await rejects(
      editComment(there, other, root._id, "hijack"),
      /Unknown message/,
    );
    await rejects(
      postComment(there, other, { text: "reply", parentId: root._id }),
      /not on board/,
    );
    await rejects(
      setCommentResolved(member, Random.id(), root._id, true),
      /Unknown comment/,
    );
  });

  describe("changes", () => {
    const heard = async (during: () => Promise<unknown>) => {
      const changes: Change[] = [];
      const stop = onChange((change) => changes.push(change));
      try {
        await during();
      } finally {
        stop();
      }
      return changes;
    };

    it("tells the room what a write touched, as it's stored", async () => {
      const id = Random.id();
      const changes = await heard(() =>
        upsertNodes(member, boardId, [
          { _id: id, type: "sticky", position: { x: 1, y: 2 }, text: "hi" },
        ]),
      );
      const node = changes.find(
        (c) => c.collection === "jr_whiteboard_nodes" && c.id === id,
      );
      assert.ok(node);
      assert.equal(node.doc?.text, "hi");
      assert.equal(node.doc?.createdBy, member.user);
      // and the version its edit recorded
      assert.ok(changes.some((c) => c.collection === "jr_whiteboard_versions"));

      const removed = await heard(() => deleteNodes(member, boardId, [id]));
      assert.deepEqual(
        removed.filter((c) => c.id === id),
        [{ collection: "jr_whiteboard_nodes", id, doc: null }],
      );
    });

    it("sends a soft delete as a change with deleted set", async () => {
      const root = await sendComment(member, "root", {
        anchor: { x: 0, y: 0 },
      });
      const changes = await heard(() => remove(member, root._id));
      const gone = changes.find((c) => c.id === root._id);
      assert.equal(gone?.collection, "board_comments");
      assert.isTrue(gone?.doc?.deleted);
    });
  });
});
