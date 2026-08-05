/**
 * Response fixtures transcribed from Elvanto's published documentation
 * examples, so the tests pin our normalization to what Elvanto says it sends.
 *
 * Where a fixture deviates from the docs it is to reproduce a real
 * inconsistency (quoted vs unquoted totals, array vs object single records) and
 * is commented as such.
 */

export const peopleGetAll = {
  generated_in: '0.021',
  status: 'ok',
  people: {
    on_this_page: 2,
    page: 1,
    per_page: 2,
    total: 5,
    person: [
      {
        id: 'b0b0d8d2-48dc-426e-aaba-774936274c99',
        date_added: '2026-02-24 11:56:22',
        date_modified: '2026-08-27 16:17:57',
        category_id: '8a631195-8914-4136-858c-f160885ab60d',
        firstname: 'John',
        lastname: 'Smith',
        email: 'john@johnsmith.com',
        status: 'Active',
        volunteer: 1,
        birthday: '1989-04-23',
        gender: 'Male',
        locations: {
          location: [
            { id: '8a631195-8914-4136-858c-f160885ab60d', name: 'Central Campus' },
          ],
        },
      },
      {
        id: 'aaaaaaaa-48dc-426e-aaba-774936274c00',
        firstname: 'Sandra',
        lastname: 'Cook',
        volunteer: 0,
        // A single-member collection arriving as a bare object rather than an array.
        locations: { location: { id: 'north', name: 'North Campus' } },
      },
    ],
  },
}

export const peopleGetInfo = {
  generated_in: '0.018',
  status: 'ok',
  // Single records come back as a one-element array on this endpoint.
  person: [
    {
      id: 'b0b0d8d2-48dc-426e-aaba-774936274c99',
      firstname: 'John',
      preferred_name: 'Jonny',
      lastname: 'Smith',
      email: 'john@johnsmith.com',
      admin: 0,
      archived: 0,
      contact: 0,
      volunteer: 1,
      status: 'Active',
      family_id: 10, // A plain integer, unlike every other id.
      birthday: '1989-04-23',
      locations: {
        location: [
          { id: '8a631195-8914-4136-858c-f160885ab60d', name: 'Central Campus' },
          { id: '9f3aec97-3d61-471d-ab50-5f28070d970d', name: 'North Campus' },
        ],
      },
      // Observed on a live account: `family` is an object holding the family's own
      // ID plus its members, not a collection of people as the field name implies.
      family: {
        family_id: '10',
        family_member: [
          { id: 'aaa', firstname: 'Jane', lastname: 'Smith', relationship: 'Spouse' },
          { id: 'bbb', firstname: 'Kim', lastname: 'Smith', relationship: 'Child' },
        ],
      },
      reports_to: '',
      'custom_77493627-aaba-426e-48dc-b0b0d8d24c99': 'Gardner',
    },
  ],
}

/**
 * Observed on a live account: `school_grade` is documented as a name but comes
 * back as an `{id, name}` object when set, and `""` when not. The first record
 * also carries the unset form, so both shapes appear in one page.
 */
export const peopleWithSchoolGrade = {
  status: 'ok',
  people: {
    page: 1,
    per_page: 3,
    on_this_page: 3,
    total: 3,
    person: [
      { id: 'p1', firstname: 'Ada', volunteer: 1, school_grade: '' },
      {
        id: 'p2',
        firstname: 'Bo',
        volunteer: 0,
        school_grade: { id: 'g4', name: 'Year 4' },
      },
      { id: 'p3', firstname: 'Cy', volunteer: 1, school_grade: 'Year 5' },
    ],
  },
}

export const transactionGetInfo = {
  generated_in: '0.018',
  status: 'ok',
  // Note: a bare object here, not an array — unlike people/getInfo.
  transaction: {
    id: '3b6339b6-d893-49a1-a2ef-ef4304b7044c',
    person_id: 'aee5f2d5-0333-11e5-bd65-06e37142e2e1',
    person_first_name: 'Evelyn',
    person_last_name: 'Cantu',
    transaction_date: '2026-07-25',
    transaction_datetime: '2026-07-25T20:44:00+00:00',
    transaction_method: 'Cash',
    check_number: '',
    batch: {
      id: '6df121c3-49c9-4754-8754-c395360242fd',
      number: '15', // Quoted here, numeric in getAll.
      name: 'Sunday Batch: 2023-01-01',
    },
    transaction_total: '360.00', // Quoted here, numeric in getAll.
    amounts: {
      amount: [
        {
          id: '6a4c9d48-6e0f-4a76-993b-b369a9895c9b',
          category: {
            id: 'b07130e3-0c26-4455-a1b0-b0ca8af5bac3',
            name: 'Missions / Thailand Orphanage',
          },
          total: '360.00',
          tax_deductible: 0,
          memo: '',
          external_notes: '',
        },
      ],
    },
    created_by_id: '',
    created_by_first_name: null, // Explicit nulls on system-created records.
    created_by_last_name: null,
    created_at: '2026-07-25T20:44:00+00:00',
    updated_at: '2026-07-26T01:30:25+00:00',
  },
}

export const serviceGetInfo = {
  generated_in: '0.018',
  status: 'ok',
  service: [
    {
      id: 'b0b0d8d2-48dc-426e-aaba-774936274c99',
      status: 1,
      name: 'Sunday Morning',
      series_name: 'The Good Fight Of Faith',
      date: '2026-08-24 09:30:00',
      service_type: { id: '8a631195-8914-4136-858c-f160885ab60d', name: 'Sunday Mornings' },
      location: { id: '8a631195-8914-4136-858c-f160885ab60d', name: 'Central Campus' },
      service_times: {
        service_time: [
          {
            id: '6276c128-1fd9-11e3-8b45-5e1036dfbe18',
            name: 'First Service',
            starts: '2026-08-24 09:30:00',
            ends: '2026-08-24 11:00:00',
          },
        ],
      },
      plans: {
        plan: [
          {
            time_id: '6276c128-1fd9-11e3-8b45-5e1036dfbe18',
            service_length: 5400,
            service_length_formatted: '90:00',
            total_length: 9000,
            items: {
              item: [
                {
                  id: 'f1d85614-15f2-11e4-acc9-d60ec099bdeb',
                  heading: 0,
                  duration: '05:00',
                  title: 'Intro video',
                  song: '', // Empty string, not null, when the row isn't a song.
                  description: '<p>Play intro video</p>',
                },
                {
                  id: '11e4aede-15f2-fae8-acc9-d60ec099bdeb',
                  heading: 0,
                  duration: '05:00',
                  title: 'How Great Is Our God',
                  song: {
                    id: '07327f00-c4f8-11e2-a836-d99a7990664d',
                    ccli_number: '1234567',
                    title: 'How Great Is Our God',
                    artist: 'Chris Tomlin',
                    arrangement: {
                      id: '0732cbc2-c4f8-11e2-a836-d99a7990664d',
                      title: 'Default Arrangement',
                      bpm: '78',
                      sequence: '', // A string here; an array on the songs endpoints.
                      key: 'G',
                    },
                  },
                  description: '',
                },
              ],
            },
          },
        ],
      },
      volunteers: {
        // Keyed "plan", same as running sheets, despite being unrelated.
        plan: [
          {
            time_id: '6276c128-1fd9-11e3-8b45-5e1036dfbe18',
            positions: {
              position: [
                {
                  department_id: 'ceb5ee64-8895-102d-80ee-95364de284f0',
                  department_name: 'Music',
                  sub_department_name: 'Vocals',
                  position_id: 'f00c68ea-8895-102d-80ee-95364de284f0',
                  position_name: 'BV1',
                  volunteers: {
                    volunteer: [
                      {
                        person: {
                          id: 'dc37a11e-8d49-102d-815d-7f9c91035bbf',
                          firstname: 'John',
                          lastname: 'Smith',
                        },
                        status: 'Confirmed',
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
      songs: {
        song: [
          {
            id: 'a3dbaee0-b84b-11e2-bcbc-2c3ca68fd88f',
            ccli_number: '12345678',
            title: 'All I Need Is You',
            artist: '',
            arrangement: {
              id: 'd88fee0-b84b-11e2-bcbc-2c3ca68fa3dba',
              title: 'Default Arrangement',
              duration: '4:56',
              key: '',
            },
          },
        ],
      },
      files: {
        file: [
          {
            id: 'd2a59ffe-15fc-11e4-acc9-d60ec099bdeb',
            title: 'Google',
            type: 'File',
            html: 0,
            content: 'http://www.google.com',
          },
        ],
      },
      notes: { note: [{ id: '3e88b32a-609d-11e3-9b6b-9ace39b5dd37', note: '<p>A random note!</p>' }] },
    },
  ],
}

export const peopleFlowsGetAll = {
  generated_in: '1.40',
  status: 'ok',
  people_flows: {
    on_this_page: 1,
    page: 1,
    per_page: 1,
    total: 1,
    // Plain JSON arrays here — People Flows skips the singular-key wrapper.
    people_flow: [
      {
        status: '',
        name: 'First Time Giver',
        access: '',
        steps: [
          {
            name: 'Thank You Letter/Email',
            status: '',
            entry_point: '',
            steps: [],
            admins: [],
            id: '489874a7-5a62-453e-bfef-a8b5a0c3aa2b',
          },
        ],
        admins: ['45a5f2f5-f828-11e4-bd65-06e37142e2e1'],
        locations: [],
        demographics: [],
        id: 'e568d7a3-766a-4400-a11f-0c5185d1206c',
      },
    ],
  },
}

export const calendarGetAll = {
  status: 'ok',
  generated_in: '0.018',
  calendars: {
    on_this_page: 2,
    per_page: 2,
    total: 2,
    page: 1,
    calendar: [
      {
        id: '4bafffc6-8040-4d96-aeff-28699ff6d687',
        name: 'Member Area Calendar',
        color: '',
        // Booleans as quoted strings on this endpoint.
        members: 'true',
        published: 'true',
      },
      {
        id: '9829556c-b916-4f1c-9c39-576698948f99',
        name: 'Staff Only Calendar',
        color: '#dc7405',
        members: 'false',
        published: 'true',
      },
    ],
  },
}

export const customFieldsGetAll = {
  generated_in: '0.014',
  status: 'ok',
  custom_fields: {
    on_this_page: 2,
    page: 1,
    per_page: 2,
    total: 2,
    custom_field: [
      {
        id: '67621d54-38eb-11e0-8ebe-bea1eec205d1',
        name: 'Ministries',
        type: 'select_multi',
        values: {
          value: [
            { id: '6e38c70e-38eb-11e0-8ebe-bea1eec205d1', name: 'Golf Guys' },
            { id: '5788c70e-54eb-11e0-3ebe-bea2eec205d5', name: 'Tea Troops' },
          ],
        },
      },
      // No `values` key at all for scalar field types.
      { id: '6e38c70e-38eb-11e0-8ebe-bea1eec205d1', name: 'Allergies', type: 'text' },
    ],
  },
}

/** Elvanto's failure envelope, which arrives with HTTP 200 on some endpoints. */
export const failEnvelope = {
  generated_in: '0.004',
  status: 'fail',
  error: { code: 250, message: 'Invalid page size' },
}

export const notFoundEnvelope = {
  generated_in: '0.004',
  status: 'fail',
  error: { code: 404, message: 'No people match your criteria' },
}
