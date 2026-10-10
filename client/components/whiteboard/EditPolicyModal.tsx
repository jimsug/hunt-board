import { faUserLock } from "@fortawesome/free-solid-svg-icons/faUserLock";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { setWhiteboardEditPolicy } from "client/methods";
import type { WhiteboardEditPolicy } from "lib/models/Whiteboards";
import { WhiteboardEditPolicies } from "lib/models/Whiteboards";
import React, { useCallback, useId, useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import FormCheck from "react-bootstrap/FormCheck";
import FormControl from "react-bootstrap/FormControl";
import FormGroup from "react-bootstrap/FormGroup";
import FormLabel from "react-bootstrap/FormLabel";
import FormText from "react-bootstrap/FormText";
import Modal from "react-bootstrap/Modal";
import { useTranslation } from "react-i18next";

// What each policy is called, in the dialog and on its toolbar button.
function useEditPolicyLabels(): Record<WhiteboardEditPolicy, string> {
  const { t } = useTranslation();
  return {
    members: t("whiteboard.editPolicy.members", "Everyone in the hunt"),
    operators: t("whiteboard.editPolicy.operators", "Operators only"),
    operatorsAndEditors: t(
      "whiteboard.editPolicy.operatorsAndEditors",
      "Operators and people they choose",
    ),
  };
}

// Opens the who-can-edit dialog, and says what the board is set to now.
export const EditPolicyButton = ({
  policy,
  onClick,
}: {
  policy: WhiteboardEditPolicy;
  onClick: () => void;
}) => {
  const { t } = useTranslation();
  const labels = useEditPolicyLabels();
  return (
    <Button
      size="sm"
      variant="outline-secondary"
      onClick={onClick}
      title={t(
        "whiteboard.editPolicy.buttonTitle",
        "Who can edit: {{policy}}",
        {
          policy: labels[policy],
          // React escapes attributes, so i18next's escaping would only show
          // entities. Goes once both i18n inits stop escaping.
          interpolation: { escapeValue: false },
        },
      )}
      aria-label={t("whiteboard.editPolicy.button", "Who can edit")}
    >
      <FontAwesomeIcon icon={faUserLock} />
    </Button>
  );
};

const PolicyChoice = ({
  id,
  name,
  policy,
  label,
  checked,
  disabled,
  onChoose,
}: {
  id: string;
  name: string;
  policy: WhiteboardEditPolicy;
  label: string;
  checked: boolean;
  disabled: boolean;
  onChoose: (policy: WhiteboardEditPolicy) => void;
}) => {
  const onChange = useCallback(() => onChoose(policy), [onChoose, policy]);
  return (
    <FormCheck
      type="radio"
      id={id}
      name={name}
      label={label}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
    />
  );
};

// The editors as typed: one id per line, or separated by spaces or commas.
const parseEditors = (text: string) =>
  text.split(/[\s,]+/).filter((id) => id.length > 0);

// Chooses who may edit the board. Starts from the board as it is when
// opened. The service knows nobody's name but those on the board, so the
// people who may edit are a list of Jolly Roger user ids for now.
const EditPolicyModal = ({
  boardId,
  initialPolicy,
  initialEditors,
  onHide,
}: {
  boardId: string;
  initialPolicy: WhiteboardEditPolicy;
  initialEditors: string[];
  onHide: () => void;
}) => {
  const { t } = useTranslation();
  const idPrefix = useId();
  const [policy, setPolicy] = useState<WhiteboardEditPolicy>(initialPolicy);
  const [editorsText, setEditorsText] = useState(initialEditors.join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const onEditorsChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setEditorsText(event.target.value),
    [],
  );

  const save = useCallback(() => {
    setSaving(true);
    setError(undefined);
    setWhiteboardEditPolicy.call(
      { boardId, editPolicy: policy, editors: parseEditors(editorsText) },
      (err) => {
        setSaving(false);
        if (err) {
          setError(err.reason ?? err.message);
        } else {
          onHide();
        }
      },
    );
  }, [boardId, policy, editorsText, onHide]);

  const labels = useEditPolicyLabels();
  const pickerId = `${idPrefix}-editors`;

  return (
    // Stays open until a save comes back, so a failure has somewhere to show.
    <Modal
      show
      onHide={onHide}
      backdrop={saving ? "static" : true}
      keyboard={!saving}
    >
      <Modal.Header closeButton={!saving}>
        <Modal.Title>
          {t("whiteboard.editPolicy.title", "Who can edit the board")}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <FormGroup className="mb-3">
          {WhiteboardEditPolicies.map((p) => (
            <PolicyChoice
              key={p}
              id={`${idPrefix}-${p}`}
              name={`${idPrefix}-policy`}
              policy={p}
              label={labels[p]}
              checked={policy === p}
              disabled={saving}
              onChoose={setPolicy}
            />
          ))}
          <FormText>
            {t(
              "whiteboard.editPolicy.help",
              "Everyone in the hunt can still view the board and comment.",
            )}
          </FormText>
        </FormGroup>
        <FormGroup className="mb-3">
          <FormLabel htmlFor={pickerId}>
            {t("whiteboard.editPolicy.pickPeople", "People who can edit")}
          </FormLabel>
          <FormControl
            id={pickerId}
            as="textarea"
            rows={4}
            value={editorsText}
            disabled={saving || policy !== "operatorsAndEditors"}
            onChange={onEditorsChange}
          />
          <FormText>
            {t(
              "whiteboard.editPolicy.pickPeopleByIdHelp",
              "Their Jolly Roger user ids, one per line. Used when the board is set to operators and people they choose.",
            )}
          </FormText>
        </FormGroup>
        {error && <Alert variant="danger">{error}</Alert>}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onHide} disabled={saving}>
          {t("common.cancel", "Cancel")}
        </Button>
        <Button variant="primary" onClick={save} disabled={saving}>
          {t("common.save", "Save")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

export default EditPolicyModal;
