import { Message, Util, MessageAttachment } from 'discord.js';
import Database from 'better-sqlite3';
import * as https from 'https';
import * as diff from 'recursive-diff';
import * as he from 'he';
import * as _ from 'lodash';
import * as fs from 'fs';
import * as path from 'path';
module.exports = {
    deliverablesGraphql: fs.readFileSync(path.join(__dirname, '..', 'graphql', 'deliverables.graphql'), 'utf-8'),
    teamsGraphql: fs.readFileSync(path.join(__dirname, '..', 'graphql', 'teams.graphql'), 'utf-8'),
    name: '!roadmap',
    description: 'Keeps track of roadmap changes from week to week. Pull the latest version of the roadmap for today or to compare the latest pull to the previous.',
    usage: 'Usage: `!roadmap [pull/compare]`',
    execute(msg: Message, args: Array<string>, db: Database) {
        if(args.length !== 1) {
            msg.channel.send(this.usage).catch(console.error);
            return;
        }

        // const officer = msg.guild.roles.cache.find(role => role.name === 'Officer');
        // if(officer && !msg.member.roles.highest.comparePositionTo(officer)) {
        //     // inufficient privileges
        //     return;
        // }

        switch(args[0]) {
            case 'pull':
                this.lookup([], msg, db);
                break;
            case 'compare':
                this.compare([], msg, db);
                break;
            case 'teams':
                // TODO display current work being done based on team start/end dates from timeAllocations_diff table
                console.log("!roadmap teams not implemented yet");
                break;
            default:
                msg.channel.send(this.usage).catch(console.error);
                break;
        }
    },
    SortByEnum: Object.freeze({
        ALPHABETICAL: "ALPHABETICAL",
        CHRONOLOGICAL: "CHRONOLOGICAL"
    }),
    CategoryEnum: Object.freeze({
        CoreTech: 1,
        Gameplay: 2,
        Characters: 3,
        Locations: 4,
        AI: 5,
        ShipsAndVehicles: 6,
        WeaponsAndItems: 7
    }),
    QueryTypeEnum: Object.freeze({
        Deliverables: 1,
        Teams: 2
    }),
    ProjectEnum: Object.freeze({
        SQ42: "el2codyca4mnx",
        SC: "ekm24a6ywr3o3"
    }),
    options: {
        hostname: 'robertsspaceindustries.com',
        path: '/graphql',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
    },
    async lookup(argv: Array<string>, msg: Message, db: Database) {
        msg.channel.send('Retrieving roadmap state...').catch(console.error);
        let start = Date.now();
        let deliverables = [];
        let offset = 0;
        const sortBy = 'd' in argv ? this.SortByEnum.CHRONOLOGICAL : this.SortByEnum.ALPHABETICAL;
        const initialResponse = await this.getResponse(this.deliverablesQuery(offset, 1, sortBy), this.QueryTypeEnum.Deliverables); // just needed for the total count; could speed up by only grabbing this info and not the rest of the metadata
        let deliverablePromises = [];

        do {
            deliverablePromises.push(this.getResponse(this.deliverablesQuery(offset, 20, sortBy), this.QueryTypeEnum.Deliverables));
            offset += 20;
        } while(offset < initialResponse.totalCount)

        Promise.all(deliverablePromises).then((responses)=>{
            let teamPromises = [];
            responses.forEach((response)=>{
                let metaData = response.metaData;
                deliverables = deliverables.concat(metaData);
            });

            // only show tasks that complete in the future
            if('n' in argv) {
                const now = Date.now();
                deliverables = deliverables.filter(d => new Date(d.endDate).getTime() > now);
            }
            
            // only show tasks that have expired or been completed
            if('o' in argv) {
                const now = Date.now();
                deliverables = deliverables.filter(d => new Date(d.endDate).getTime() <= now);
            }
            
            // sort by soonest expiring
            if('e' in argv) {
                deliverables.sort((a,b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime() || new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
            }

            // download and attach development team time assignments to each deliverable
            deliverables.forEach((d) => {
                teamPromises.push(this.getResponse(this.teamsQuery(offset, d.slug), this.QueryTypeEnum.Teams));
            });

            Promise.all(teamPromises).then(async (responses) => {
                responses.forEach((response, index)=>{
                    // order is preserved, team index matches deliverable index
                    let metaData = response.metaData;
                    deliverables[index].teams = metaData;
                });
                
                let delta = Date.now() - start;
                console.log(`Deliverables: ${deliverables.length} in ${delta} milliseconds`);
                const dbDate = new Date(start).toISOString().split("T")[0].replace(/-/g,'');
                const existingRoadmap: any = db.prepare('SELECT * FROM roadmap ORDER BY date DESC').get();
                const newRoadmap = JSON.stringify(deliverables, null, 2)

                let insert = !existingRoadmap;
                
                if(existingRoadmap) {
                    insert = !_.isEqual(existingRoadmap.json, newRoadmap);
                }

                if(insert||true) {
                    db.prepare("INSERT OR REPLACE INTO roadmap (json, date) VALUES (?,?)").run([newRoadmap, dbDate]);
                    msg.channel.send(`Roadmap retrieval returned ${deliverables.length} deliverables in ${delta} ms. Type \`!roadmap compare\` to compare to the last update!`).catch(console.error);
                    await this.compare([], msg, db, true);
                } else {
                    msg.channel.send('No changes have been detected since the last pull.').catch(console.error);
                }
            });
        });
    },
    async getResponse(data, type) {
        return await new Promise((resolve, reject) => {
            const req = https.request(this.options, (res) => {
              let data = '';
    
              res.on('data', (d) => {
                data += d;
              });
              res.on('end', () => {
                switch(type){
                    case 1: // Deliverables
                        resolve(JSON.parse(data).data.progressTracker.deliverables);
                        break;
                    case 2: // Teams 
                        resolve(JSON.parse(data).data.progressTracker.teams);
                        break;
                    default:
                        reject(`Invalid response query type ${type}`);
                        break;
                }
              });
            });
    
            req.on('error', (error) => {
              reject(error);
            });
    
            req.write(data);
            req.end();
        });
    },
    deliverablesQuery(offset: number =0, limit: number=20, sortBy=this.SortByEnum.ALPHABETICAL, projectSlugs=[], categoryIds=[]) {
        let query: any = {
            operationName: "deliverables",
            query: this.deliverablesGraphql,
            variables: {
                "startDate": "2020-01-01",
                "endDate": "2023-12-31",
                "limit": limit,
                "offset": offset,
                "sortBy": `${sortBy}`
            }
        };
        
        if(projectSlugs.length) {
            query.projectSlugs = JSON.stringify(projectSlugs);
        }
        
        if(categoryIds.length) {
            query.categoryIds = JSON.stringify(categoryIds);
        }
        
        return JSON.stringify(query);
    },
    teamsQuery(offset: number =0, deliverableSlug: String, sortBy=this.SortByEnum.ALPHABETICAL) {
        let query: any = {
            operationName: "teams",
            query: this.teamsGraphql,
            variables: {
                "startDate": "2020-01-01",
                "endDate": "2050-12-31",
                "limit": 20,
                "offset": offset,
                "sortBy": `${sortBy}`,
                "deliverableSlug": deliverableSlug,
            }
        };

        return JSON.stringify(query);
    },
    async compare(argv: Array<string>, msg: Message, db: Database, insertChanges: boolean = false) {
        // TODO add start/end filter
        msg.channel.send('Calculating differences between roadmaps...').catch(console.error);
        const results: any = db.prepare('SELECT * FROM roadmap ORDER BY date DESC LIMIT 2').all();
        if(!results || results.length < 2) {
            msg.channel.send('More than one roadmap snapshot is needed to compare. Pull and try again later.').catch(console.error);
            return;
        }
        const first = JSON.parse(results[1].json);
        const last = JSON.parse(results[0].json);

        const compareTime = Date.now();

        let messages = [];
        
        const removedDeliverables = first.filter(f => !last.some(l => l.uuid === f.uuid || l.title === f.title));
        if(removedDeliverables.length) {
            messages.push(`[${removedDeliverables.length}] deliverable(s) *removed*:\n`);
            removedDeliverables.forEach(d => {
                messages.push(he.unescape(`\* ${d.title}\n`.toString()));
                messages.push(he.unescape(this.shortenText(`${d.description}\n`)));

                // removed deliverable implies associated time allocations were removed; no description necessary
            });
            messages.push('===================================================================================================\n\n');
        }

        const newDeliverables = last.filter(l => !first.some(f => l.uuid === f.uuid || (l.title && l.title === f.title && !l.title.includes("Unannounced"))));
        let changedTeams = [];
        let changedTimeAllocations = [];
        let changedCards = [];
        if(newDeliverables.length) {
            messages.push(`[${newDeliverables.length}] deliverable(s) *added*:\n`);
            newDeliverables.forEach(d => {
                const start = new Date(d.startDate).toDateString();
                const end = new Date(d.endDate).toDateString();
                messages.push(he.unescape(`\* **${d.title.trim()}**\n`.toString()));
                messages.push(he.unescape(`${start} => ${end}\n`.toString()));
                messages.push(he.unescape(this.shortenText(`${d.description}\n`)));

                // todo - new teams, etc
                // check for diffs in each list
                if(d.card) {
                    let card = {

                    };
                    let sner = card;
                    //reamainingCards.push(card);
                }

                if(d.teams) {
                    d.teams.forEach((t)=>{
                        //t.timeAllocations
                    });
                }
            });
            messages.push('===================================================================================================\n\n');
        }

        const remainingDeliverables = first.filter(f => last.some(l => l.uuid === f.uuid || l.title === f.title));
        let updatedDeliverables = [];
        if(remainingDeliverables.length) {
            let updatedMessages = [];
            remainingDeliverables.forEach(f => {
                const l = last.find(x => x.uuid === f.uuid || (f.title && x.title === f.title && !f.title.includes("Unannounced")));
                const d = diff.getDiff(f, l);
                if(d.length && l) {
                    const changes = d.map(x => ({op: x.op, change: x.path && x.path[0], val: x.val}));
                    
                    if(changes.some(p => p.op === 'update' && (p.change === 'endDate' || p.change === 'startDate' || p.change === 'title' || p.change === 'description'))) {
                        const title = f.title === 'Unannounced' ? `${f.title} (${f.description})` : f.title;
                        let update = `\* **${title}**\n`;
                        
                        if(changes.some(p => p.change === 'startDate')) {
                            const oldDate = new Date(f.startDate);
                            const oldDateText = oldDate.toDateString();
                            const newDate = new Date(l.startDate);
                            const newDateText = newDate.toDateString();
                            
                            let updateText = "";
                            if(Date.parse(oldDateText) < compareTime && Date.parse(newDateText) < compareTime) {
                                updateText = "been corrected"; // shift in either direction is most likely a time allocation correction
                            } else if(newDate < oldDate) {
                                updateText = "moved closer";
                            } else if(oldDate < newDate) {
                                updateText = "pushed back";
                            }

                            update += `Start date has ${updateText} from ${oldDateText} to ${newDateText}\n`;
                        }
                        if(changes.some(p => p.change === 'endDate')) {
                            const oldDate = new Date(f.endDate);
                            const oldDateText = oldDate.toDateString();
                            const newDate = new Date(l.endDate);
                            const newDateText = newDate.toDateString();
                            
                            let updateText = "";
                            if(compareTime < Date.parse(oldDateText) && Date.parse(newDateText) < compareTime) {
                                updateText = "moved earlier (time allocation removal(s) likely)\n"; // likely team time allocation was removed, but could have finished early
                            } else if(oldDate < newDate) {
                                updateText = "been extended";
                            } else if(newDate < oldDate) {
                                updateText = "moved closer";
                            }

                            update += `End date has ${updateText} from ${oldDateText} to ${newDateText}\n`;
                        }

                        if(changes.some(p => p.change === 'title')) {
                            update += this.shortenText(`Title has been updated from "${f.title}" to "${l.title}"`);
                        }
                        if(changes.some(p => p.change === 'description')) {
                            update += this.shortenText(`Description has been updated from\n"${f.description}"\nto\n"${l.description}"`);
                        }
                        updatedMessages.push(he.unescape(update + '\n'));
                        updatedDeliverables.push(f);
                    }

                    // todo - updated teams, etc
                }
            });
            messages.push(`[${updatedDeliverables.length}] deliverable(s) *updated*:\n`);
            messages = messages.concat(updatedMessages);
            messages.push(`[${remainingDeliverables.length - updatedDeliverables.length}] deliverable(s) *unchanged*`);
        }

        await msg.channel.send({files: [new MessageAttachment(Buffer.from(messages.join(''), "utf-8"), `roadmap_${results[0].date}.md`)]}).catch(console.error);

        // update database
        if(insertChanges){
            new Promise((resolve, reject) => {
                let then = Date.now();
                console.log("Storing delta");
                let deliverableDeltas = db.prepare("SELECT COUNT(*) as count FROM deliverable_diff").get();
                if(!deliverableDeltas.count) {
                    // initialize starting values
                    // TODO get all cards, teams, and time allocations
                    this.insertChanges(db, then, last);
                } else {
                    // only insert updates
                    this.insertChanges(db, then, removedDeliverables, true);
                    this.insertChanges(db, then, newDeliverables);
                    this.insertChanges(db, then, updatedDeliverables);
                }
                
                resolve(console.log(`Database updated with delta in ${Date.now() - then} ms`));
            });
        }
    },
    shortenText(text) { // shortens text to 100 characters per line for discord display
        return `${text.replace(/(?![^\n]{1,100}$)([^\n]{1,100})\s/g, '$1\n')}\n`.toString();
    },
    insertChanges(db: Database, now: number, deliverables: [any], removed: boolean = false) {
        const deliverableInsert = db.prepare("INSERT INTO deliverable_diff (uuid, slug, title, description, addedDate, numberOfDisciplines, numberOfTeams, totalCount, card_id, project_ids, team_ids, timeAllocation_ids, startDate, endDate, updateDate) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
        const cardsInsert = db.prepare("INSERT INTO card_diff (tid, title, description, category, release_id, release_title, updateDate, addedDate, thumbnail) VALUES (?,?,?,?,?,?,?,?,?)");
        const teamsInsert = "";
        const timeAllocationInsert = "";

        const insertMany = db.transaction((dList: [any]) => {
            dList.forEach((d) => {
                // card_diff
                let card_id = [];
                // team_diff
                let team_ids = [];
                // timeAllocation_diff
                let timeAllocation_ids = [];

                let projectIds = d.projects.map(p => { return p.title === 'Star Citizen' ? 'SC' : (p.title === 'Squadron 42' ? 'SQ42' : null); }).toString();

                let row = deliverableInsert.run([d.uuid, d.slug, d.title, d.description, now, d.numberOfDisciplines, d.numberOfTeams, d.totalCount, null, projectIds, null, null,
                    removed?null:Date.parse(d.startDate), removed?null:Date.parse(d.endDate), removed?null:Date.parse(d.updateDate)]);

                // card_id, project_ids, team_ids, timeAllocation_ids

                let rowId = row.lastInsertRowid;
            });
        });

        insertMany(deliverables);
    }
};