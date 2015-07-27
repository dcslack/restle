// dependencies
import express from 'express';
import mongoose from 'mongoose';
import inflect from 'i';
import _ from 'lodash';
import Serializer from '../serializer';

// router utilites
import populateString from './utils/populate-string';
import parseSchema from './utils/parse-schema';

// general utilites
import parseModelName from '../utils/parse-model-name';

export default class Router {
  constructor(options = {}) {
    /**
     * Restle uses the express `Router` class for creating routes and parsing
     * http requests and responses.
     *
     * @type {express.Router}
     */
    this.router = new express.Router();

    /**
     * This class handles serializing incoming requests and outgoing responses.
     *
     * @param {Object} options
     * @type {Serializer}
     */
    this.serializer = new Serializer(options);

    /**
     * This object maintains `attributes` and `relationships` for all the
     * registered models.
     *
     * ```js
     * // example
     * {
     *   user: {
     *     relationships: {
     *       comments: { type: 'comment', isMany: true },
     *       pet: { type: 'animal', isMany: false },
     *       ...
     *     },
     *     attributes: {
     *       name: { type: 'string' },
     *       birthday: { type: 'date' },
     *       ...
     *     }
     *   }
     * }
     * ```
     *
     * This allows the Router to easily access a registered model's attribute
     * `type` and relationship `isMany`, which is especially useful when
     * serializing data.
     *
     * @type {Object}
     */
    this.fields = {};

    // creates the proper routes for resource objects and relationships
    this.setupRoutes();

    // expose the inflect instance for this class
    this.i = inflect();

    // setup the options
    this.origin = options.origin || 'http://localhost';;
    this.port = options.port || 3000;
    this.namespace = options.namespace || '/';
  }

  /**
   * This checks the validity of a schema then adds it to the `this.fields`
   * object and registers it under mongoose.
   *
   * @param {String} model
   * @param {Object} schema
   * @return {mongoose.Model}
   */
  register(model, schema) {
    // TODO: needs refactoring
    const parsedSchema = parseSchema(schema);
    const modelName = parseModelName(model);
    const Model = mongoose.model(modelName, parsedSchema);
    let fields, fieldType;

    this.fields[modelName] = {
      relationships: {},
      attributes: {},
    };

    fields = this.fields[modelName];

    // TODO: error checking for invalid attributes and relationships and duplicates
    _.each(_.keys(schema), key => {
      fieldType = schema[key];

      if (fieldType.attr) {
        fields.attributes[key] = { type: fieldType.attr };
      } else if (fieldType.hasMany) {
        fields.relationships[key] = { type: fieldType.hasMany, isMany: true };
      } else {
        fields.relationships[key] = { type: fieldType.belongsTo, isMany: false };
      }
    });

    return Model;
  }

  /**
   * This method checks to see if a model named `type` is registered under
   * `this.fields`, and if it is returns the Mongoose instance of it.
   *
   * @param {String} type
   * @return {mongoose.Model}
   */
  model(type) {
    const fields = this.fields;
    const modelName = parseModelName(type);

    if (!fields[modelName]) {
      return false;
    }

    return mongoose.model(modelName);
  }

  /**
   * This method fetches all resources of type `req.params.type`, then
   * serializes the response JSON.
   *
   * TODO: inclusion, pagination, filtering, sorting, fields
   *
   * @param {Object} req
   * @param {Object} res
   */
  findAllResources(req, res) {
    const { type } = req.params;
    const Model = this.model(type);
    const serializer = this.serializer;

    let fields;
    let pagination;
    let sort = '';
    let query = req.query;

    // FIXME: not sure if 404 is correct status
    if (!Model) {
      return res.sendStatus(404);
    }

    // TODO: method for handling pagination and errors
    // pagination
    if (query && query.page) {
      pagination = {
        skip: query.page.offset,
        limit: query.page.limit,
      };

      delete query.page;
    }

    // sorting
    if (query && query.sort) {
      sort = query.sort.split(',').join(' ');
      delete query.sort;
    }

    // TODO: fields
    if (query && query.fields) {
      delete query.fields;
    }

    const populatedString = populateString(this, type);

    Model.find(query, {}, pagination)
      .sort(sort)
      .populate(populatedString)
      .lean()
      .exec((err, resources) => {
        if (err) {
          return res.status(500).json(err);
        }

        return res.json(serializer.serializeResponse(this, 'get', type, resources));
    });
  }

  /**
   * This method fetches a single resources of type `req.params.type`, then
   * serializes the response JSON.
   *
   * @param {Object} req
   * @param {Object} res
   */
  findResource(req, res) {
    const { type, query, id } = req.params;
    const Model = this.model(type);
    const serializer = this.serializer;

    // FIXME: not sure if 404 is correct status
    if (!Model) {
      return res.sendStatus(404);
    }

    const populatedString = populateString(this, type);

    Model.findById(id)
      .populate(populatedString)
      .lean()
      .exec((err, resource) => {
        if (err) {
          if (err.name === 'CastError' && err.type === 'ObjectId') {
            return res.status(403).json({
              errors: [{
                status: 403,
                title: 'Invalid resource id',
                detail: 'A valid resource id is required when PATCHING or DELETING or GETTING.',
              }],
            });
          }

          return res.sendStatus(500);
        }

        if (!resource) {
          return res.status(404).json({
            errors: [{
              status: 404,
              title: 'Resource not found',
              detail: `Could not find the resource of type ${type} with id ${id}`,
            }],
          });
        }

        return res.json(serializer.serializeResponse(this, 'get', type, resource));
    });
  }

  /**
   * This method creates a single resources of type `req.params.type`, then
   * serializes the response JSON.
   *
   * @param {Object} req
   * @param {Object} res
   */
  createResource(req, res) {
    const i = inflect();
    const type = req.params.type;
    const Model = this.model(type);
    const body = req.body;
    const serializer = this.serializer;

    // FIXME: not sure if 404 is correct status
    if (!Model) {
      return res.sendStatus(404);
    }

    const serialized = serializer.serializeRequest(body);

    if (serialized.errors) {
      return res.status(serialized.errors[0].status).json(serialized);
    }

    if (i.singularize(body.data.type) !== i.singularize(type)) {
      return res.status(409).json({
        errors: [{
          status: 409,
          title: 'Type does not match endpoint',
          detail: 'The primary data type must match the endpoint when POSTING or PATCHING.',
        }],
      });
    }

    // TODO: make sure the type property matches the endpoint
    Model.create(serialized, (err, resource) => {
      if (err) {
        return res.status(500).json(err);
      }

      Model.populate(resource, 'pets', (err, resource) => {
        res.set('location', `${this.origin}:${this.port}${this.namespace}/${i.pluralize(type)}/${resource._id}`);
        //console.log(prettyjson.render(serializer.serializeResponse(this, 'post', type, resource.toObject())));
        res.status(201).json(serializer.serializeResponse(this, 'post', type, resource.toObject()));
      });
    });
  }

  /**
   * This method updates a single resources of type `req.params.type`, then
   * sends a 204.
   *
   * TODO: send a 200 if any other properties outside the request context change
   *
   * @param {Object} req
   * @param {Object} res
   */

  updateResource(req, res) {
    const { type, id } = req.params;
    const body = req.body;
    const Model = this.model(type);
    const serializer = this.serializer;
    const i = inflect();

    if (!Model) {
      return res.sendStatus(403);
    }

    if (i.singularize(body.data.type) !== i.singularize(type)) {
      return res.status(409).json({
        errors: [{
          status: 409,
          title: 'Type does not match endpoint',
          detail: 'The primary data type must match the endpoint when POSTING or PATCHING.',
        }],
      });
    }

    if (id !== body.data.id) {
      return res.status(409).json({
        errors: [{
          status: 409,
          title: 'Id does not match endpoint',
          detail: 'The primary data id must match the endpoint when PATCHING or DELETING.',
        }],
      });
    }

    const serialized = serializer.serializeRequest(body);

    Model.findByIdAndUpdate(id, serialized, (err, resource) => {
      if (err) {
        if (err.name === 'CastError' && err.type === 'ObjectId') {
          return res.status(403).json({
            errors: [{
              status: 403,
              title: 'Invalid resource id',
              detail: 'A valid resource id is required when PATCHING or DELETING.',
            }],
          });
        }

        return res.sendStatus(500);
      }

      if (!resource) {
        return res.status(404).json({
          errors: [{
            status: 404,
            title: 'Resource not found',
            detail: `Could not find the resource of type ${type} with id ${id}.`,
          }],
        });
      }

      return res.sendStatus(204);
    });
  }

  /**
   * This method deletes a single resources of type `req.params.type` with an id
   * of `req.params.id`.
   *
   * @param {Object} req
   * @param {Object} res
   */
  deleteResource(req, res) {
    const type = req.params.type;
    const id = req.params.id;
    const Model = this.model(type);
    const serializer = this.serializer;

    if (!Model) {
      return res.sendStatus(403);
    }

    Model.findByIdAndRemove(id, err => {
      if (err) {
        if (err.name === 'CastError' && err.type === 'ObjectId') {
          return res.status(403).json({
            errors: [{
              status: 403,
              title: 'Invalid resource id',
              detail: 'A valid resource id is required when PATCHING or DELETING.',
            }],
          });
        }

        return res.sendStatus(500);
      }

      return res.sendStatus(204);
    });
  }

  /**
   * This method returns the appropriate relationship based on `req.params.type`
   * and `req.params.id` and `req.params.field`.
   *
   * @param {Object} req
   * @param {Object} res
   */
  findRelationship(req, res) {
    const type = req.params.type;
    const id = req.params.id;
    const field = req.params.field;
    const Model = this.model(type);
    const serializer = this.serializer;

    Model.findById(id)
      .populate(field)
      .lean()
      .exec((err, resource) => {
        if (err) {
          if (err.name === 'CastError' && err.type === 'ObjectId') {
            return res.status(403).json({
              errors: [{
                status: 403,
                title: 'Invalid resource id',
                detail: 'A valid resource id is required when PATCHING or DELETING.',
              }],
            });
          }

          return res.sendStatus(500);
        }

        return res.status(200).json({
          links: {
            self: `${this.origin}:${this.port}${this.namespace}/${type}/${id}/relationships/${field}`,
            related: `${this.origin}:${this.port}${this.namespace}/${type}/${id}/${field}`,
          },
          data: serializer.serializeRelationship(this, type, field, resource[field]),
        });
    });
  }

  /**
   * This method appends a resource identifier object to a relationship array.
   *
   * @param {Object} req
   * @param {Object} res
   */
  appendRelationship(req, res) {
    const type = req.params.type;
    const id = req.params.id;
    const field = req.params.field;
    const body = req.body;
    const Model = this.model(type);

    let update = {
      $push: {
        [field]: {
          $each: {},
        },
      },
    };

    if (!Model) {
      return res.sendStatus(403);
    }

    // TODO: 409 error
    update.$push[field].$each = _.map(body.data, relationship => {
      return relationship.id;
    });

    Model.findByIdAndUpdate(id, update, (err, resource) => {
      if (err) {
        if (err.name === 'CastError' && err.type === 'ObjectId') {
          return res.status(403).json({
            errors: [{
              status: 403,
              title: 'Invalid resource id',
              detail: 'A valid resource id is required when PATCHING or DELETING.',
            }],
          });
        }

        return res.sendStatus(500);
      }

      // TODO: send 200 if there is a computed property
      return res.sendStatus(204);
    });
  }

  /**
   * This method performs a full-replacement of a relationship.
   *
   * @param {Object} req
   * @param {Object} res
   */
  updateRelationship(req, res) {
    const type = req.params.type;
    const id = req.params.id;
    const field = req.params.field;
    const body = req.body;
    const Model = this.model(type);

    let update;

    if (!Model) {
      return res.sendStatus(403);
    }

    // TODO: 409 error
    if (_.isArray(body.data)) {
      if (_.isEmpty(body.data)) {
        update = { [field]: [] };
      } else {
        update = {};
        update.data = _.map(body, relationship => {
          return { [field]: relationship.data.id };
        });
      }
    } else {
      update = body.data ? { [field]: body.data.id } : { [field]: null };
    }

    Model.findByIdAndUpdate(id, update, (err, resource) => {
      if (err) {
        if (err.name === 'CastError' && err.type === 'ObjectId') {
          return res.status(403).json({
            errors: [{
              status: 403,
              title: 'Invalid resource id',
              detail: 'A valid resource id is required when PATCHING or DELETING.',
            }],
          });
        }

        return res.sendStatus(500);
      }

      // TODO: send 200 if there is a computed property
      return res.sendStatus(204);
    });
  }

  /**
   * This method removes all the appropriate relationships from the resource
   * based on the request body.
   *
   * @param {Object} req
   * @param {Object} res
   */
  deleteRelationship(req, res) {
    const type = req.params.type;
    const id = req.params.id;
    const field = req.params.field;
    const body = req.body;
    const Model = this.model(type);

    let update = {
      $pullAll: {
        [field]: {},
      },
    };

    if (!Model) {
      return res.sendStatus(403);
    }

    // TODO: 409 error
    update.$pullAll[field] = _.map(body.data, relationship => {
      return relationship.id;
    });

    Model.findByIdAndUpdate(id, update, (err, resource) => {
      if (err) {
        if (err.name === 'CastError' && err.type === 'ObjectId') {
          return res.status(403).json({
            errors: [{
              status: 403,
              title: 'Invalid resource id',
              detail: 'A valid resource id is required when PATCHING or DELETING.',
            }],
          });
        }

        return res.sendStatus(500);
      }

      // TODO: send 200 if there is a computed property
      return res.sendStatus(204);
    });
  }

  /**
   * This method creates the appropriate routes determined by the JSON API spec:
   *
   * ```js
   *   GET /:type
   *   POST /:type
   *
   *   GET /:type/:id
   *   PATCH /:type/:id
   *   DELETE /:type/:id
   *
   *   GET /:type/:id/relationships/:field
   *   POST /:type/:id/relationships/:field
   *   PATCH /:type/:id/relationships/:field
   *   DELETE /:type/:id/relationships/:field
   * ```
   *
   * @param {Object} req
   * @param {Object} res
   */
  setupRoutes() {
    const router = this.router;
    const manyResourcesEndpoint = `/:type`;
    const singleResourceEndpoint = `/:type/:id`;
    const relationshipEndpoint = `/:type/:id/relationships/:field`;

    router.route(manyResourcesEndpoint)
      .get((req, res) => {
        this.findAllResources(req, res);
      })
      .post((req, res) => {
        this.createResource(req, res);
      });

    router.route(singleResourceEndpoint)
      .get((req, res) => {
        this.findResource(req, res);
      })
      .patch((req, res) => {
        this.updateResource(req, res);
      })
      .delete((req, res) => {
        this.deleteResource(req, res);
      });

    router.route(relationshipEndpoint)
      .get((req, res) => {
        this.findRelationship(req, res);
      })
      .post((req, res) => {
        this.appendRelationship(req, res);
      })
      .patch((req, res) => {
        this.updateRelationship(req, res);
      })
      .delete((req, res) => {
        this.deleteRelationship(req, res);
      });
  }
}