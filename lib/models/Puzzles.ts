import { z } from "zod";
import { answer, foreignKey, nonEmptyString } from "../typedModel/customTypes";
import type { ModelType } from "../typedModel/Model";
import { Url } from "../typedModel/regexes";
import SoftDeletedModel from "../typedModel/SoftDeletedModel";
import withCommon from "../typedModel/withCommon";

const tagList = foreignKey.array().default([]).meta({ uniqueItems: true });

// The service's copy of Jolly Roger's puzzles, fed to it over DDP: only the
// fields the board reads, under the names Jolly Roger gives them, so the
// board code is the same on both sides. Ids are Jolly Roger's.
const Puzzle = withCommon(
  z.object({
    hunt: foreignKey,
    tags: tagList,
    title: nonEmptyString,
    url: z.string().regex(Url).optional(),
    answers: answer.array(),
    // -1 means nobody knows how many answers the puzzle has yet. Such a puzzle
    // is never shown as solved until the count is corrected.
    expectedAnswerCount: z.int32().min(-1),
    completedWithNoAnswer: z.boolean().optional(),
    // When answers last changed, set by whatever adds or removes one, and by
    // marking the puzzle complete with no answer or taking that back. Unset
    // on puzzles answered before it was recorded.
    answersUpdatedAt: z.date().optional(),
    replacedBy: foreignKey.optional(),
    // A locked puzzle is one the team hasn't unlocked on the hunt site yet.
    locked: z.boolean().optional(),
    // "whiteboard" marks the hidden puzzle that anchors a hunt whiteboard's
    // chat and call. Absent means an ordinary puzzle.
    kind: z.enum(["whiteboard"]).optional(),
  }),
);

const Puzzles = new SoftDeletedModel("jr_puzzles", Puzzle);
Puzzles.addIndex({ deleted: 1, hunt: 1 });
Puzzles.addIndex({ hunt: 1 });
export type PuzzleType = ModelType<typeof Puzzles>;

export default Puzzles;
