export const feedbackBytes = 1600;

export function createFeedback(database) {
  return {
    async list(clinicId) {
      const { rows } = await database.query(
        'SELECT id,conteudo,criado_em FROM sdr.clinic_feedback WHERE clinica_id=$1 ORDER BY criado_em,id', [clinicId]
      );
      return rows;
    },
    async save(clinicId, content) {
      const result = await database.query(
        'INSERT INTO sdr.clinic_feedback(clinica_id,slot,conteudo) ' +
        'SELECT $1,slot,$2 FROM generate_series(1,16) AS slots(slot) ' +
        'WHERE NOT EXISTS (SELECT 1 FROM sdr.clinic_feedback WHERE clinica_id=$1 AND clinic_feedback.slot=slots.slot) ' +
        'ORDER BY slot LIMIT 1 ON CONFLICT (clinica_id,slot) DO NOTHING', [clinicId, content]
      );
      return result.rowCount === 1;
    },
    async remove(clinicId, id) {
      const result = await database.query('DELETE FROM sdr.clinic_feedback WHERE clinica_id=$1 AND id=$2', [clinicId, id]);
      return result.rowCount === 1;
    }
  };
}
