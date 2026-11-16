import {Context} from './interfaces';
import * as db from './db';
import {Config} from './interfaces';

/**
 * Check permissions of group and admin
 * @param {Context} ctx
 * @param {Object} config
 * @return {Promise} promise
 */
function checkRights(
    ctx: Context,
    config: { categories: any[]; staffchat_id: any },
) {
  return new Promise(function(resolve) {
    // Recompute access for this chat; an empty/stale groupAdmin is not a role.
    ctx.session.groupAdmin = undefined;
    // Is staff - category group
    if (config.categories) {
      config.categories.forEach((element, index) => {
        // No subgroup
        if (!config.categories[index].subgroups?.length) {
          if (config.categories[index].group_id == ctx.chat.id) {
            ctx.session.groupAdmin = config.categories[index].name;
          }
        } else {
          config.categories[index].subgroups.forEach(
              (
              // eslint-disable-next-line max-len
                  innerElement: { group_id: { toString: () => any }; name: any },
                  _index: any,
              ) => {
                if (innerElement.group_id == ctx.chat.id) {
                  ctx.session.groupAdmin = innerElement.name;
                }
              },
          );
        }
      });
    }
    if (ctx.session.groupAdmin && ctx.chat.type == 'private') {
      ctx.session.groupAdmin = undefined;
    }
    // Is admin group
    if (
      String(ctx.chat.id) === String(config.staffchat_id) ||
      ctx.session.groupAdmin
    ) {
      resolve(true);
    } else resolve(false);
  });
}

/**
 * Define user permission
 * @param {Context} ctx
 * @param {Function} next
 * @param {Config} config
 */
function checkPermissions(ctx: Context, next: () => any, config: Config) {
  ctx.session.admin = false;
  return checkRights(ctx, config)
      .then((access) => {
        const ownerInPrivate = ctx.chat.type === 'private' &&
          [config.owner_id, ...(config.owner_ids || [])]
            .some(id => id != null && String(id) === String(ctx.from?.id));
        if (access || ownerInPrivate) ctx.session.admin = true;
      })
      .then(() => {
        let banned = false;
        db.checkBan(ctx.chat.id, function(ticket) {
          banned = ticket != undefined && ticket.status === 'banned';
        });
        if (!banned) return next();
      });
}

export {checkRights, checkPermissions};
