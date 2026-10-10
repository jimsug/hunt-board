import React from "react";
import styled, { css } from "styled-components";

// Jolly Roger's Avatar without its Discord pictures: the service knows
// people by id and name only, so everyone gets their initial in their
// colour.

const AvatarInitial = styled.div`
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  color: ${({ theme }) => theme.colors.avatarInitialText};
  background-color: ${({ theme }) => theme.colors.avatarInitialBackground};
`;

// Based on Sasha Trubetskoy's List of 20 Simple, Distinct Colors
// https://sashamaps.net/docs/resources/20-colors/
const palette: [string, string][] = [
  ["#e6194B", "#ffffff"],
  ["#3cb44b", "#ffffff"],
  ["#ffe119", "#000000"],
  ["#4363d8", "#ffffff"],
  ["#f58231", "#ffffff"],
  ["#911eb4", "#ffffff"],
  ["#42d4f4", "#000000"],
  ["#f032e6", "#ffffff"],
  ["#bfef45", "#000000"],
  ["#fabed4", "#000000"],
  ["#469990", "#ffffff"],
  ["#dcbeff", "#000000"],
  ["#9A6324", "#ffffff"],
  ["#000000", "#ffffff"],
  ["#800000", "#ffffff"],
  ["#aaffc3", "#000000"],
  ["#808000", "#ffffff"],
  ["#ffd8b1", "#000000"],
  ["#000075", "#ffffff"],
  ["#a9a9a9", "#ffffff"],
];

// A user's consistent background and text colours, for their fallback avatar
// and anywhere else they need a colour of their own (their whiteboard cursor).
export function userColors(_id: string | undefined): [string, string] {
  const idSum = Array.from(_id ?? "").reduce(
    (t, c) => t + c.codePointAt(0)!,
    0,
  );
  return palette[Math.abs(idSum) % palette.length]!;
}

const DefaultAvatarInner = ({
  _id,
  displayName,
}: {
  _id?: string;
  displayName?: string;
}) => {
  const initial = displayName
    ? displayName.trim().slice(0, 1).toUpperCase()
    : "?";
  const [circleColor, initialColor] = userColors(_id);
  const style = { backgroundColor: circleColor, color: initialColor };
  return <AvatarInitial style={style}>{initial}</AvatarInitial>;
};

const AvatarContainer = styled.div<{
  $size: number;
  $inline: boolean;
  $isSelf: boolean;
  $rounded: boolean;
}>`
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  font-size: ${({ $size }) => 0.6 * $size}px;
  background-color: white;
  font-weight: 700;
  display: ${({ $inline }) => ($inline ? "inline-block" : "block")};
  box-shadow: ${({ $isSelf, theme }) =>
    $isSelf ? `0 0 4px ${theme.colors.avatarSelfShadow}` : "none"};
  border: ${({ $isSelf, theme }) =>
    $isSelf ? `0.5px solid ${theme.colors.avatarSelfBorder}` : "none"};
  ${({ $rounded }) =>
    $rounded &&
    css`
      border-radius: 50%;
      overflow: hidden;
    `}
`;

const Avatar = React.memo(
  ({
    size,
    inline,
    _id,
    displayName,
    className,
    isSelf = false,
    rounded = false,
  }: {
    size: number;
    inline?: boolean;
    _id?: string; // hashed to produce a globally consistant background color for the fallback avatar
    displayName?: string;
    className?: string;
    isSelf?: boolean;
    rounded?: boolean;
  }) => {
    const content = <DefaultAvatarInner _id={_id} displayName={displayName} />;
    return (
      <AvatarContainer
        className={className}
        $size={size}
        $inline={inline ?? false}
        $isSelf={isSelf}
        $rounded={rounded}
      >
        {content}
      </AvatarContainer>
    );
  },
);

export default Avatar;
